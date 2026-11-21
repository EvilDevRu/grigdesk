package cli

import (
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"net/http"
	"net/url"
	"strings"

	"grigdesk.local/tools/utilities/routes/internal/draft"
	"grigdesk.local/tools/utilities/routes/internal/publication"
	"grigdesk.local/tools/utilities/routes/internal/transfer"
)

var segmentEscape = strings.NewReplacer(
	"+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*",
)

func (run invocation) base() string {
	return "/api/routes/" + run.profile
}

func (run invocation) draftPath(id string) string {
	return run.base() + "/drafts/" + segmentEscape.Replace(url.QueryEscape(id))
}

// newDraft использует явный empty либо копирует только current, полученный из editor.
// Пустой current не превращается в тихое создание пустого черновика.
func (run invocation) newDraft() error {
	from, isString := run.flags.single("from")
	if _, set := run.flags["from"]; set && (!isString || from != "empty" && from != "catalog") {
		return usage("--from: empty или catalog")
	}
	body := draft.Create{Kind: "catalog", Title: run.flags.valueOr("title", "cli-draft")}
	if from == "empty" {
		body.Kind = "empty"
	} else {
		value, err := run.call(http.MethodGet, run.base()+"/editor", nil)
		if err != nil {
			return err
		}
		var current struct {
			Catalog string `json:"currentCatalogHash"`
		}
		if err := json.Unmarshal(value, &current); err != nil {
			return err
		}
		if current.Catalog == "" {
			return usage("нет опубликованного каталога: используйте --from empty")
		}
		body.CatalogHash = current.Catalog
	}
	return run.show(http.MethodPost, run.base()+"/drafts", body)
}

// draftExpectation получает пару ID и ревизии из исходного снимка пользователя.
// Её значения проверяются до файла, сети и текущей версии на сервере.
func (run invocation) draftExpectation() (string, int64, error) {
	id, err := run.flags.required("draft")
	if err != nil {
		return "", 0, err
	}
	revision, err := run.flags.revision("expected-revision", 1)
	return id, revision, err
}

// apply проверяет полный документ, сравнивает исходную ревизию и передаёт один PATCH.
// Свежий GET нужен для удалений и отбрасывания конфликта перед записью.
func (run invocation) apply() error {
	id, revision, err := run.draftExpectation()
	if err != nil {
		return err
	}
	file, err := run.flags.required("file")
	if err != nil {
		return err
	}
	raw, err := transfer.Read(file)
	if err != nil {
		return usage(err.Error())
	}
	content, err := transfer.Content(raw)
	if err != nil {
		return usage(err.Error())
	}

	path := run.draftPath(id)
	value, err := run.call(http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	var snapshot draft.Snapshot
	if err := json.Unmarshal(value, &snapshot); err != nil {
		return err
	}
	if snapshot.Revision != revision {
		return run.revisionConflict(revision, snapshot.Revision)
	}

	patch, err := draft.Replacement(snapshot, revision, content)
	if err != nil {
		return err
	}
	return run.show(http.MethodPatch, path, patch)
}

// revisionConflict выдаёт JSON исходной и текущей ревизии без второй мутации.
// Код совпадает с серверным CAS-отказом, если конфликт пойман до PATCH.
func (run invocation) revisionConflict(expected, current int64) error {
	payload := struct {
		Error    string `json:"error"`
		Expected int64  `json:"expectedRevision"`
		Current  int64  `json:"currentRevision"`
	}{Error: "routes_revision_conflict", Expected: expected, Current: current}
	if err := run.print(payload); err != nil {
		return err
	}
	return &commandError{code: 4, text: "конфликт ревизии: сопоставьте правки с новым снимком"}
}

// source передаёт смену владельца каталога отдельным подтверждённым PUT.
// CAS-пара остаётся привязанной к тому current, который видел пользователь.
func (run invocation) source() error {
	if err := run.flags.requireYes(); err != nil {
		return err
	}
	mode, err := run.flags.required("mode")
	if err != nil {
		return err
	}
	if mode != "editor" && mode != "profile-script" {
		return usage("режим: editor или profile-script")
	}
	revision, hash, err := run.flags.expected()
	if err != nil {
		return err
	}
	payload := struct {
		Mode     string  `json:"mode"`
		Revision int64   `json:"expectedSourceRevision"`
		Catalog  *string `json:"expectedCatalogHash"`
	}{Mode: mode, Revision: revision, Catalog: hash}
	return run.show(http.MethodPut, run.base()+"/editor/source", payload)
}

// validate запрашивает отчёт для конкретной ревизии сохранённого черновика.
// Содержимое отчёта передаётся целиком, включая ошибки схемы при HTTP 2xx.
func (run invocation) validate() error {
	id, revision, err := run.draftExpectation()
	if err != nil {
		return err
	}
	payload := struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}{ExpectedRevision: revision}
	return run.show(http.MethodPost, run.draftPath(id)+"/validate", payload)
}

// publish проверяет подтверждение и ожидания перед созданием копии или публикацией.
// Путь rollback меняет только ревизию черновика в уже подготовленном идентификаторе.
func (run invocation) publish(operation string) error {
	if err := run.flags.requireYes(); err != nil {
		return err
	}
	id, revision, err := run.publicationTarget(operation)
	if err != nil {
		return err
	}
	source, hash, err := run.flags.expected()
	if err != nil {
		return err
	}
	payload := publication.Prepare(revision, source, hash)
	if operation == "rollback" {
		copy, err := run.rollbackDraft(id)
		if err != nil {
			return err
		}
		id = copy.ID
		payload.ExpectedRevision = copy.Revision
	}

	return run.publishDraft(id, payload)
}

// publicationTarget различает снимок черновика и хеш каталога для копирования.
// Указанный хеш никогда не используется как ID существующего черновика.
func (run invocation) publicationTarget(operation string) (string, int64, error) {
	if operation == "publish" {
		return run.draftExpectation()
	}
	hash, err := run.flags.required("hash")
	if err != nil {
		return "", 0, err
	}
	if !hashPattern.MatchString(hash) {
		return "", 0, usage("нужен --hash <хеш ревизии>")
	}
	return hash, 1, nil
}

// publishDraft сначала записывает подсказку получения квитанции.
// Тот же идентификатор уходит в единственном POST публикации.
func (run invocation) publishDraft(id string, payload publication.Payload) error {
	hint, err := jsonv2.Marshal(payload.RecoveryHint(run.profile, id))
	if err != nil {
		return err
	}
	if _, err := run.stderr.Write(append(hint, '\n')); err != nil {
		return err
	}
	return run.show(http.MethodPost, run.draftPath(id)+"/publish", payload)
}

// rollbackDraft создаёт копию явно выбранного каталога для последующей публикации.
// При потере ответа источник операции можно выяснить отдельным list.
func (run invocation) rollbackDraft(hash string) (draft.Snapshot, error) {
	body := draft.Create{Kind: "catalog", Title: "rollback-" + hash[:8], CatalogHash: hash}
	value, err := run.call(http.MethodPost, run.base()+"/drafts", body)
	if err != nil {
		return draft.Snapshot{}, err
	}
	var result draft.Snapshot
	err = json.Unmarshal(value, &result)
	return result, err
}

// transfer выдаёт bundle на stdout или отправляет прочитанный документ с заданным заголовком.
// Импорт читает и проверяет JSON до единственного POST.
func (run invocation) transfer(operation string) error {
	if operation == "export" {
		id, err := run.flags.required("draft")
		if err != nil {
			return err
		}
		return run.show(http.MethodGet, run.draftPath(id)+"/transfer", nil)
	}
	file, err := run.flags.required("file")
	if err != nil {
		return err
	}
	bundle, err := transfer.Read(file)
	if err != nil {
		return usage(err.Error())
	}
	body := struct {
		Title  string          `json:"title"`
		Bundle json.RawMessage `json:"bundle"`
	}{Title: run.flags.valueOr("title", "cli-import"), Bundle: bundle}
	return run.show(http.MethodPost, run.base()+"/editor/import", body)
}
