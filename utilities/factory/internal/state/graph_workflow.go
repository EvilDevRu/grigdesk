package state

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/graphworkflow"
)

const graphDocumentLimit = 8 * 1024 * 1024
const graphPageSize = 30

var graphUUID = regexp.MustCompile(`^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
var graphDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)

var ErrGraphNotFound = errors.New("graph_not_found")
var ErrGraphBuiltinReadonly = errors.New("builtin_readonly")
var ErrGraphBroken = errors.New("graph_broken")

type graphEnvelope struct {
	Format   int             `json:"format"`
	Digest   string          `json:"digest"`
	Revision uint64          `json:"revision"`
	Document json.RawMessage `json:"document"`
}

// graphPublisher — подменяемый порт публикации по образцу stagePublisher.
// Отказ до rename оставляет прежние байты читаемыми из нового процесса.
type graphPublisher func(*os.Root, string, []byte, fsMode, bool) error

// GraphTemplateHeader — компактный заголовок каталога без тела документа.
type GraphTemplateHeader struct {
	ID            string `json:"id"`
	Revision      string `json:"revision"`
	BuiltIn       bool   `json:"builtIn"`
	Title         string `json:"title"`
	InputKind     string `json:"inputKind"`
	RequiresModel bool   `json:"requiresModel"`
}

// GraphRunHeader — заголовок истории; повреждённый снимок остаётся видимым.
type GraphRunHeader struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	InputKind string `json:"inputKind"`
	Status    string `json:"status"`
	CreatedAt int64  `json:"createdAt"`
	Revision  uint64 `json:"revision"`
	ErrorCode string `json:"errorCode,omitempty"`
}

// GraphBuiltinTemplate — предустановленный маршрут, доступный только чтением.
type GraphBuiltinTemplate struct {
	ID        string
	Title     string
	InputKind string
	Document  json.RawMessage
}

// graphBuiltins отдаёт канонические шаблоны первой поставки только для чтения.
var graphBuiltins = func() []GraphBuiltinTemplate {
	builtins := graphworkflow.Builtins()
	result := make([]GraphBuiltinTemplate, 0, len(builtins))
	for _, builtin := range builtins {
		result = append(result, GraphBuiltinTemplate{
			ID: builtin.ID, Title: builtin.Title, InputKind: builtin.InputKind, Document: builtin.Document,
		})
	}
	return result
}

// graphNormalizeInputs выполняет штатную нормализацию один раз до сохранения старта.
var graphNormalizeInputs = func(kind string, files []graphworkflow.InputFile) ([]graphworkflow.Row, []graphworkflow.InputFile, error) {
	snapshot, err := graphworkflow.NormalizeInputs(kind, files)
	return snapshot.Rows, snapshot.Manifest, err
}

// GraphStartRequest — заголовок старта; resolvedModelRef добавляет только сервер.
type GraphStartRequest struct {
	ID               string
	TemplateID       string
	ExpectedRevision string
	Files            []graphworkflow.InputFile
	ModelRef         graphworkflow.ModelRef
	ResolvedModelRef *graphworkflow.ModelRef
}

// withGraphWorkflowRoot сериализует проверку и публикацию снимков одной фабрики.
// Модельные вызовы происходят вне блокировки, команда только принимает готовые факты.
func (s Store) withGraphWorkflowRoot(write bool, run func(*os.Root) error) error {
	control, err := openControl(s.ControlDir, write)
	if err != nil {
		return err
	}
	defer control.Close()
	const name = "graph-workflows"
	if err := ensurePrivateDirectory(control, name, write); err != nil {
		return err
	}
	root, err := control.OpenRoot(name)
	if err != nil {
		return err
	}
	defer root.Close()
	lock, err := openDirectoryLock(root, ".", write)
	if err != nil {
		return err
	}
	defer lock.Close()
	operation := lockShared
	if write {
		operation = lockExclusive
	}
	if err := flock(lock, operation); err != nil {
		return err
	}
	for _, child := range []string{"runs", "templates", "runs-meta"} {
		if err := ensurePrivateDirectory(root, child, write); err != nil {
			return err
		}
	}
	return run(root)
}

// graphEnvelopeAt читает только полный опубликованный файл по доверенному дескриптору.
// Неизвестный формат сохраняется на диске и требует подходящего читателя.
func graphEnvelopeAt(root *os.Root, name string) (graphEnvelope, error) {
	var value graphEnvelope
	data, err := readTrusted(root, name, graphDocumentLimit, ownerMode)
	if err != nil {
		return value, err
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return value, fmt.Errorf("graph workflow: %w", err)
	}
	if value.Format != 1 || value.Revision == 0 || !graphDigest.MatchString(value.Digest) ||
		!json.Valid(value.Document) {
		return value, fmt.Errorf("graph workflow: неизвестный или повреждённый документ")
	}
	return value, nil
}

// publishGraphEnvelope использует завершённую атомарную запись Go-состояния.
// Лимит относится к сериализованным байтам, включая служебные поля.
func publishGraphEnvelope(root *os.Root, name string, value graphEnvelope, replace bool) error {
	return publishGraphEnvelopeWith(root, name, value, replace, publishFile)
}

func publishGraphEnvelopeWith(root *os.Root, name string, value graphEnvelope, replace bool,
	publish graphPublisher,
) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw) > graphDocumentLimit {
		return fmt.Errorf("graph workflow: snapshot_limit")
	}
	return publish(root, name, raw, ownerMode, replace)
}

// GraphStartDigest хеширует каноническую форму исходного запроса до нормализации модели.
// start-check и start используют один и тот же заголовок, resolvedModelRef вне digest.
func GraphStartDigest(request GraphStartRequest) string {
	header := struct {
		ID               string                    `json:"id"`
		TemplateID       string                    `json:"templateId"`
		ExpectedRevision string                    `json:"expectedRevision"`
		Files            []graphworkflow.InputFile `json:"files"`
		ModelRef         graphworkflow.ModelRef    `json:"modelRef"`
	}{request.ID, request.TemplateID, request.ExpectedRevision, request.Files, request.ModelRef}
	raw, _ := json.Marshal(header)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func graphCanonicalDigest(document []byte) (string, []byte, error) {
	definition, err := graphworkflow.DecodeDefinition(document)
	if err != nil {
		return "", nil, err
	}
	canonical, err := json.Marshal(definition)
	if err != nil {
		return "", nil, err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), canonical, nil
}

// StartGraphDocument связывает ключ старта с исходными входами.
// Повтор получает последнюю запись даже после смены автора или завершения веток.
func (s Store) StartGraphDocument(id, digest string, initial []byte) ([]byte, error) {
	if !graphUUID.MatchString(id) || !graphDigest.MatchString(digest) || !json.Valid(initial) {
		return nil, fmt.Errorf("graph workflow: неверный start")
	}
	var actual []byte
	name := filepath.Join("runs", id+".json")
	err := s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		found, err := graphEnvelopeAt(root, name)
		if err == nil {
			if found.Digest != digest {
				return ErrConflict
			}
			actual = found.Document
			return nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		actual = initial
		value := graphEnvelope{Format: 1, Digest: digest, Revision: 1, Document: initial}
		return publishGraphEnvelope(root, name, value, false)
	})
	return actual, err
}

// WriteGraphDocument публикует только следующий снимок известного прогона.
// CAS и замена файла охватываются одним коротким участком записи.
func (s Store) WriteGraphDocument(id, digest string, expected uint64, next []byte) error {
	return s.writeGraphDocumentWith(id, digest, expected, next, publishFile)
}

func (s Store) writeGraphDocumentWith(id, digest string, expected uint64, next []byte,
	publish graphPublisher,
) error {
	if !graphUUID.MatchString(id) || !graphDigest.MatchString(digest) || !json.Valid(next) {
		return fmt.Errorf("graph workflow: неверный update")
	}
	name := filepath.Join("runs", id+".json")
	return s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		value, err := graphEnvelopeAt(root, name)
		if err != nil {
			return err
		}
		if value.Digest != digest || value.Revision != expected {
			return ErrConflict
		}
		value.Revision++
		value.Document = next
		return publishGraphEnvelopeWith(root, name, value, true, publish)
	})
}

// MutateGraphRun читает, пересчитывает и публикует снимок под одним writer-lock.
// Возврат false,nil не двигает ревизию; ожидаемая ревизия проверяется до работы.
func (s Store) MutateGraphRun(id string, expected *uint64,
	fn func(*graphworkflow.Snapshot) (bool, error),
) (uint64, error) {
	if !graphUUID.MatchString(id) {
		return 0, fmt.Errorf("graph workflow: неверный id прогона")
	}
	var revision uint64
	name := filepath.Join("runs", id+".json")
	err := s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		value, err := graphEnvelopeAt(root, name)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return ErrGraphNotFound
			}
			return ErrGraphBroken
		}
		if expected != nil && value.Revision != *expected {
			return ErrConflict
		}
		var snapshot graphworkflow.Snapshot
		if err := json.Unmarshal(value.Document, &snapshot); err != nil {
			return ErrGraphBroken
		}
		changed, err := fn(&snapshot)
		if err != nil {
			return err
		}
		if !changed {
			revision = value.Revision
			return nil
		}
		document, err := json.Marshal(&snapshot)
		if err != nil {
			return err
		}
		value.Revision++
		value.Document = document
		if err := publishGraphEnvelope(root, name, value, true); err != nil {
			return err
		}
		revision = value.Revision
		return nil
	})
	return revision, err
}

// ReadGraphRun возвращает оболочку и снимок под shared-lock без создания каталога.
func (s Store) ReadGraphRun(id string) (graphEnvelope, *graphworkflow.Snapshot, error) {
	var value graphEnvelope
	var snapshot graphworkflow.Snapshot
	if !graphUUID.MatchString(id) {
		return value, nil, fmt.Errorf("graph workflow: неверный id прогона")
	}
	name := filepath.Join("runs", id+".json")
	err := s.withGraphWorkflowRoot(false, func(root *os.Root) error {
		found, err := graphEnvelopeAt(root, name)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return ErrGraphNotFound
			}
			return ErrGraphBroken
		}
		if err := json.Unmarshal(found.Document, &snapshot); err != nil {
			return ErrGraphBroken
		}
		value = found
		return nil
	})
	if err != nil {
		return value, nil, err
	}
	return value, &snapshot, nil
}

// SaveGraphTemplate валидирует документ и сверяет хеш текущей редакции под lock.
// Встроенные ID доступны только чтением, такой же digest считается успешным повтором.
func (s Store) SaveGraphTemplate(id string, expectedRevision *string, document []byte) (GraphTemplateHeader, []byte, error) {
	var header GraphTemplateHeader
	if strings.HasPrefix(id, "builtin-") {
		return header, nil, ErrGraphBuiltinReadonly
	}
	if !graphUUID.MatchString(id) {
		return header, nil, fmt.Errorf("id: нужен UUID шаблона")
	}
	digest, canonical, err := graphCanonicalDigest(document)
	if err != nil {
		return header, nil, err
	}
	name := filepath.Join("templates", id+".json")
	err = s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		found, err := graphEnvelopeAt(root, name)
		if err == nil {
			if expectedRevision == nil || *expectedRevision != found.Digest {
				return ErrConflict
			}
			if found.Digest == digest {
				header = GraphTemplateHeader{ID: id, Revision: found.Digest, Title: found.title(), InputKind: found.inputKind()}
				canonical = found.Document
				return nil
			}
			value := graphEnvelope{Format: 1, Digest: digest, Revision: found.Revision + 1, Document: canonical}
			if err := publishGraphEnvelope(root, name, value, true); err != nil {
				return err
			}
			header = GraphTemplateHeader{ID: id, Revision: digest, Title: titleOf(canonical), InputKind: inputKindOf(canonical)}
			return nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if expectedRevision != nil {
			return ErrConflict
		}
		value := graphEnvelope{Format: 1, Digest: digest, Revision: 1, Document: canonical}
		if err := publishGraphEnvelope(root, name, value, false); err != nil {
			return err
		}
		header = GraphTemplateHeader{ID: id, Revision: digest, Title: titleOf(canonical), InputKind: inputKindOf(canonical)}
		return nil
	})
	return header, canonical, err
}

func (value graphEnvelope) title() string     { return titleOf(value.Document) }
func (value graphEnvelope) inputKind() string { return inputKindOf(value.Document) }

func titleOf(document []byte) string {
	var definition graphworkflow.Definition
	_ = json.Unmarshal(document, &definition)
	return definition.Title
}

func inputKindOf(document []byte) string {
	var definition graphworkflow.Definition
	_ = json.Unmarshal(document, &definition)
	return definition.InputKind
}

// ReadGraphTemplate отдаёт встроенный или сохранённый документ с ревизией-хешем.
func (s Store) ReadGraphTemplate(id string) (GraphTemplateHeader, []byte, error) {
	for _, builtin := range graphBuiltins() {
		if builtin.ID == id {
			return s.readTemplateLocked(nil, id)
		}
	}
	var header GraphTemplateHeader
	var document []byte
	err := s.withGraphWorkflowRoot(false, func(root *os.Root) error {
		var err error
		header, document, err = s.readTemplateLocked(root, id)
		return err
	})
	if errors.Is(err, os.ErrNotExist) {
		err = ErrGraphNotFound
	}
	return header, document, err
}

// graphTemplateRequiresModel считывает ту же схему, которую использует старт.
// Каталог сообщает нужность модели до выбора файлов и исполнителя.
func graphTemplateRequiresModel(document []byte) bool {
	definition, err := graphworkflow.DecodeDefinition(document)
	return err == nil && definition.RequiresModel()
}

// ListGraphTemplates сортирует каталог по ID и отдаёт страницу до 30 заголовков.
// Чистая установка без хранилища возвращает встроенные шаблоны без создания каталога.
func (s Store) ListGraphTemplates(cursor string) ([]GraphTemplateHeader, string, error) {
	position, err := decodeGraphCursor(cursor, "templates")
	if err != nil {
		return nil, "", err
	}
	headers := make([]GraphTemplateHeader, 0)
	for _, builtin := range graphBuiltins() {
		digest, _, err := graphCanonicalDigest(builtin.Document)
		if err != nil {
			continue
		}
		headers = append(headers, GraphTemplateHeader{
			ID: builtin.ID, Revision: digest, BuiltIn: true, Title: builtin.Title, InputKind: builtin.InputKind, RequiresModel: graphTemplateRequiresModel(builtin.Document),
		})
	}
	err = s.withGraphWorkflowRoot(false, func(root *os.Root) error {
		entries, err := fs.ReadDir(root.FS(), "templates")
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if !entry.Type().IsRegular() || !strings.HasSuffix(name, ".json") {
				continue
			}
			id := strings.TrimSuffix(name, ".json")
			found, err := graphEnvelopeAt(root, filepath.Join("templates", name))
			if err != nil {
				continue
			}
			headers = append(headers, GraphTemplateHeader{
				ID: id, Revision: found.Digest, Title: found.title(), InputKind: found.inputKind(), RequiresModel: graphTemplateRequiresModel(found.Document),
			})
		}
		return nil
	})
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	}
	slices.SortFunc(headers, func(left, right GraphTemplateHeader) int {
		return strings.Compare(left.ID, right.ID)
	})
	page := make([]GraphTemplateHeader, 0, graphPageSize)
	for _, header := range headers {
		if position.LastID != "" && header.ID <= position.LastID {
			continue
		}
		page = append(page, header)
		if len(page) == graphPageSize {
			break
		}
	}
	next := ""
	if len(page) == graphPageSize && len(headers) > graphPageSize {
		next = encodeGraphCursor(graphCursor{List: "templates", LastID: page[len(page)-1].ID})
	}
	return page, next, nil
}

// graphRunMeta — приватный заголовок истории, публикуется до первого снимка.
type graphRunMeta struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	InputKind string `json:"inputKind"`
	CreatedAt int64  `json:"createdAt"`
}

// StartGraphRun принимает новый старт или узнаёт повтор по digest под writer-lock.
// Заголовок истории пишется до снимка, нормализация выполняется один раз.
func (s Store) StartGraphRun(request GraphStartRequest, now int64) (uint64, error) {
	if !graphUUID.MatchString(request.ID) {
		return 0, fmt.Errorf("id: нужен UUID прогона")
	}
	digest := GraphStartDigest(request)
	var revision uint64
	name := filepath.Join("runs", request.ID+".json")
	err := s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		found, err := graphEnvelopeAt(root, name)
		if err == nil {
			if found.Digest != digest {
				return ErrConflict
			}
			revision = found.Revision
			return nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return ErrGraphBroken
		}
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		if index.FaultUntil > now {
			return GraphAdmissionPausedError{Until: index.FaultUntil}
		}
		header, document, err := s.readTemplateLocked(root, request.TemplateID)
		if err != nil {
			return err
		}
		if header.Revision != request.ExpectedRevision {
			return ErrConflict
		}
		definition, err := graphworkflow.DecodeDefinition(document)
		if err != nil {
			return err
		}
		if runtime.GOOS == "windows" && definition.RequiresModel() {
			return fmt.Errorf("workflow_model_unsupported")
		}
		rows, manifest, err := graphNormalizeInputs(definition.InputKind, request.Files)
		if err != nil {
			return err
		}
		snapshot := graphworkflow.NewRun(definition, rows)
		snapshot.ID = request.ID
		snapshot.TemplateID = request.TemplateID
		snapshot.TemplateRevision = request.ExpectedRevision
		snapshot.CreatedAt = now
		snapshot.Manifest = manifest
		snapshot.ModelRef = request.ModelRef
		if request.ResolvedModelRef != nil {
			snapshot.ModelRef = *request.ResolvedModelRef
		}
		if err := snapshot.Advance(); err != nil {
			return err
		}
		meta := graphRunMeta{ID: request.ID, Title: definition.Title, InputKind: definition.InputKind, CreatedAt: now}
		metaRaw, err := json.Marshal(meta)
		if err != nil {
			return err
		}
		if graphKeepsMarker(snapshot) {
			if !slices.Contains(index.Active, request.ID) && len(index.Active) >= graphActiveLimit {
				return errGraphActiveLimit
			}
			graphMarkActive(&index, request.ID)
		} else {
			graphUnmarkActive(&index, request.ID)
		}
		if err := publishGraphActive(root, index); err != nil {
			return err
		}
		metaName := filepath.Join("runs-meta", request.ID+".json")
		if err := publishFile(root, metaName, metaRaw, ownerMode, true); err != nil {
			return err
		}
		snapshotRaw, err := json.Marshal(snapshot)
		if err != nil {
			return err
		}
		value := graphEnvelope{Format: 1, Digest: digest, Revision: 1, Document: snapshotRaw}
		if err := publishGraphEnvelope(root, name, value, false); err != nil {
			return err
		}
		revision = 1
		return nil
	})
	return revision, err
}

// readTemplateLocked ищет встроенный или сохранённый шаблон уже под блокировкой.
func (s Store) readTemplateLocked(root *os.Root, id string) (GraphTemplateHeader, []byte, error) {
	for _, builtin := range graphBuiltins() {
		if builtin.ID != id {
			continue
		}
		digest, canonical, err := graphCanonicalDigest(builtin.Document)
		if err != nil {
			return GraphTemplateHeader{}, nil, err
		}
		return GraphTemplateHeader{
			ID: id, Revision: digest, BuiltIn: true, Title: builtin.Title, InputKind: builtin.InputKind, RequiresModel: graphTemplateRequiresModel(builtin.Document),
		}, canonical, nil
	}
	if !graphUUID.MatchString(id) {
		return GraphTemplateHeader{}, nil, ErrGraphNotFound
	}
	found, err := graphEnvelopeAt(root, filepath.Join("templates", id+".json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return GraphTemplateHeader{}, nil, ErrGraphNotFound
		}
		return GraphTemplateHeader{}, nil, ErrGraphBroken
	}
	return GraphTemplateHeader{ID: id, Revision: found.Digest, Title: found.title(), InputKind: found.inputKind(),
		RequiresModel: graphTemplateRequiresModel(found.Document)}, found.Document, nil
}

// StartCheck проверяет существование принятого старта без создания записи.
func (s Store) StartCheck(request GraphStartRequest) (bool, uint64, error) {
	if !graphUUID.MatchString(request.ID) {
		return false, 0, fmt.Errorf("id: нужен UUID прогона")
	}
	digest := GraphStartDigest(request)
	found := false
	var revision uint64
	name := filepath.Join("runs", request.ID+".json")
	err := s.withGraphWorkflowRoot(false, func(root *os.Root) error {
		value, err := graphEnvelopeAt(root, name)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return ErrGraphBroken
		}
		if value.Digest != digest {
			return ErrConflict
		}
		found = true
		revision = value.Revision
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return false, 0, nil
	}
	return found, revision, err
}

// ListGraphRuns читает заголовки истории страницей; повреждённые остаются видимыми.
func (s Store) ListGraphRuns(cursor string) ([]GraphRunHeader, string, error) {
	position, err := decodeGraphCursor(cursor, "runs")
	if err != nil {
		return nil, "", err
	}
	metas := make([]graphRunMeta, 0)
	err = s.withGraphWorkflowRoot(false, func(root *os.Root) error {
		entries, err := fs.ReadDir(root.FS(), "runs-meta")
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if !entry.Type().IsRegular() || !strings.HasSuffix(name, ".json") {
				continue
			}
			raw, err := readTrusted(root, filepath.Join("runs-meta", name), graphDocumentLimit, ownerMode)
			if err != nil {
				continue
			}
			var meta graphRunMeta
			if err := json.Unmarshal(raw, &meta); err != nil || !graphUUID.MatchString(meta.ID) {
				continue
			}
			metas = append(metas, meta)
		}
		return nil
	})
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	}
	slices.SortFunc(metas, func(left, right graphRunMeta) int {
		if left.CreatedAt != right.CreatedAt {
			if left.CreatedAt > right.CreatedAt {
				return -1
			}
			return 1
		}
		return strings.Compare(left.ID, right.ID)
	})
	page := make([]GraphRunHeader, 0, graphPageSize)
	for _, meta := range metas {
		if position.LastID != "" {
			if meta.CreatedAt > position.CreatedAt {
				continue
			}
			if meta.CreatedAt == position.CreatedAt && meta.ID <= position.LastID {
				continue
			}
		}
		header := GraphRunHeader{
			ID: meta.ID, Title: meta.Title, InputKind: meta.InputKind, CreatedAt: meta.CreatedAt,
		}
		value, snapshot, err := s.ReadGraphRun(meta.ID)
		switch {
		case err == nil:
			header.Status = snapshot.Status()
			header.Revision = value.Revision
		case errors.Is(err, ErrGraphNotFound):
			continue
		default:
			header.Status = "unavailable"
			header.ErrorCode = "graph_broken"
		}
		page = append(page, header)
		if len(page) == graphPageSize {
			break
		}
	}
	next := ""
	if len(page) == graphPageSize {
		last := page[len(page)-1]
		next = encodeGraphCursor(graphCursor{List: "runs", LastID: last.ID, CreatedAt: last.CreatedAt})
	}
	return page, next, nil
}

type graphCursor struct {
	List      string `json:"list"`
	LastID    string `json:"lastId,omitempty"`
	CreatedAt int64  `json:"createdAt,omitempty"`
}

func encodeGraphCursor(value graphCursor) string {
	raw, _ := json.Marshal(value)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// decodeGraphCursor проверяет opaque курсор списка до чтения записей.
// Пустой курсор означает первую страницу, размер ограничен 128 ASCII-символами.
func decodeGraphCursor(raw, list string) (graphCursor, error) {
	var value graphCursor
	if raw == "" {
		return value, nil
	}
	if len(raw) > 128 {
		return value, fmt.Errorf("cursor: превышен размер")
	}
	for _, symbol := range raw {
		if symbol > 127 {
			return value, fmt.Errorf("cursor: недопустимые символы")
		}
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return value, fmt.Errorf("cursor: неверная форма")
	}
	if err := json.Unmarshal(decoded, &value); err != nil || value.List != list {
		return value, fmt.Errorf("cursor: неверный список")
	}
	return value, nil
}

// graphValidateSources сверяет источники выхода с точными метками входов листа.
// Чужая метка отвергается даже от внутреннего порта, без частичного принятия.
func graphValidateSources(snapshot *graphworkflow.Snapshot, node *graphworkflow.Instance, rows []graphworkflow.Row) error {
	inputs, err := snapshot.RowsFor(graphworkflow.ResultRef{ID: node.ID, Generation: node.Generation}, 4*1024*1024)
	if err != nil {
		return err
	}
	allowed := map[string]bool{}
	for _, input := range inputs {
		for _, source := range input.Sources {
			allowed[graphSourceLabel(source)] = true
		}
	}
	for _, row := range rows {
		for _, source := range row.Sources {
			if !allowed[graphSourceLabel(source)] {
				return fmt.Errorf("sources: чужая метка источника")
			}
		}
	}
	return nil
}

func graphSourceLabel(source graphworkflow.SourceRef) string {
	timeMs := "-"
	if source.TimeMs != nil {
		timeMs = strconv.FormatInt(*source.TimeMs, 10)
	}
	return source.InputKey + "/" + strconv.Itoa(source.Line) + "/" + timeMs
}

// GraphClaimJob — задание приватному worker без пользовательских полей и путей.
type GraphClaimJob struct {
	ID         string                 `json:"id"`
	NodeID     string                 `json:"nodeId"`
	Generation uint64                 `json:"generation"`
	ClaimID    string                 `json:"claimId"`
	Kind       string                 `json:"kind"`
	Prompt     string                 `json:"prompt,omitempty"`
	Feedback   string                 `json:"feedback,omitempty"`
	ModelRef   graphworkflow.ModelRef `json:"modelRef"`
	InputKind  string                 `json:"inputKind"`
	Rows       []graphworkflow.Row    `json:"rows"`
	ExpiresAt  int64                  `json:"expiresAt"`
}

// GraphUpdate — адресная инвалидация принятого изменения снимка.
type GraphUpdate struct {
	ID       string `json:"id"`
	Revision uint64 `json:"revision,omitempty"`
}

// GraphClaimResult — одна выдача транзакции и список зафиксированных изменений.
type GraphClaimResult struct {
	Job        *GraphClaimJob `json:"job"`
	Changed    []GraphUpdate  `json:"changed"`
	Pending    bool           `json:"pending"`
	NextWakeAt int64          `json:"nextWakeAt,omitempty"`
}

// GraphAdmissionPausedError сообщает срок остановки новых выдач и стартов.
type GraphAdmissionPausedError struct {
	Until int64
}

func (err GraphAdmissionPausedError) Error() string { return "workflow_admission_paused" }

var errGraphIndexBroken = errors.New("workflow_storage_invalid")
var errGraphActiveLimit = errors.New("active_workflow_limit")
var errGraphOperationLimit = errors.New("operation_limit")

type graphActiveIndex struct {
	Format       int                          `json:"format"`
	Active       []string                     `json:"active"`
	FaultUntil   int64                        `json:"faultUntil,omitempty"`
	Reservations map[string]*graphReservation `json:"reservations,omitempty"`
}

func graphHasReservation(index *graphActiveIndex, id string) bool {
	for _, reservation := range index.Reservations {
		if reservation.ID == id {
			return true
		}
	}
	return false
}

const (
	graphActiveLimit   = 32
	graphFaultHorizon  = int64(6 * 60 * 1000)
	graphEventLimit    = 512
	graphAttemptLimit  = 16
	graphRowLimit      = 256
	graphRowBytesLimit = 16 * 1024
)

// graphActiveAt читает индекс активных прогонов; отсутствие означает пустой набор.
// Повреждение самого индекса останавливает выдачи до ручной диагностики.
func graphActiveAt(root *os.Root) (graphActiveIndex, error) {
	raw, err := readTrusted(root, "active.json", graphDocumentLimit, ownerMode)
	if errors.Is(err, os.ErrNotExist) {
		return graphActiveIndex{Format: 1}, nil
	}
	if err != nil {
		return graphActiveIndex{}, err
	}
	var index graphActiveIndex
	if err := json.Unmarshal(raw, &index); err != nil || index.Format != 1 || len(index.Active) > graphActiveLimit {
		return index, errGraphIndexBroken
	}
	for _, id := range index.Active {
		if !graphUUID.MatchString(id) {
			return index, errGraphIndexBroken
		}
	}
	return index, nil
}

func publishGraphActive(root *os.Root, index graphActiveIndex) error {
	raw, err := json.Marshal(index)
	if err != nil {
		return err
	}
	return publishFile(root, "active.json", raw, ownerMode, true)
}

func readGraphRunLocked(root *os.Root, id string) (graphEnvelope, *graphworkflow.Snapshot, error) {
	value, err := graphEnvelopeAt(root, filepath.Join("runs", id+".json"))
	if err != nil {
		return value, nil, err
	}
	var snapshot graphworkflow.Snapshot
	if err := json.Unmarshal(value.Document, &snapshot); err != nil {
		return value, nil, ErrGraphBroken
	}
	return value, &snapshot, nil
}

func graphClaimCount(snapshot *graphworkflow.Snapshot) int {
	count := 0
	for _, id := range snapshot.Order {
		if node := snapshot.Nodes[id]; node != nil && node.Claim != nil {
			count++
		}
	}
	return count
}

func graphReadyCount(snapshot *graphworkflow.Snapshot) int {
	count := 0
	for _, id := range snapshot.Order {
		if node := snapshot.Nodes[id]; node != nil && node.Status == "ready" {
			count++
		}
	}
	return count
}

// graphKeepsMarker держит активный маркер до терминального или припаркованного снимка.
func graphKeepsMarker(snapshot *graphworkflow.Snapshot) bool {
	if graphClaimCount(snapshot) > 0 {
		return true
	}
	switch snapshot.Status() {
	case "done", "failed", "rejected", "paused":
		return false
	}
	return true
}

func graphMarkActive(index *graphActiveIndex, id string) {
	if slices.Contains(index.Active, id) {
		return
	}
	index.Active = append(index.Active, id)
}

func graphUnmarkActive(index *graphActiveIndex, id string) {
	index.Active = slices.DeleteFunc(index.Active, func(value string) bool { return value == id })
}

func graphRandomToken() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return ""
	}
	return hex.EncodeToString(buffer)
}

func graphAttemptCount(snapshot *graphworkflow.Snapshot, nodeID string) int {
	count := 0
	for _, event := range snapshot.Events {
		if event.NodeID == nodeID && (event.Kind == "settle" || event.Kind == "expire") {
			count++
		}
	}
	return count
}

// graphValidateSettlement проверяет форму выхода до принятия снимком.
// Точная привязка источников к показанным меткам добавляется на шаге 5.
func graphValidateSettlement(result graphworkflow.Settlement) error {
	if len(result.Rows) > graphRowLimit {
		return fmt.Errorf("rows: превышено число строк выхода")
	}
	seen := map[string]bool{}
	for _, row := range result.Rows {
		if row.Key == "" || seen[row.Key] {
			return fmt.Errorf("rows: ключи строк должны быть уникальны")
		}
		seen[row.Key] = true
		raw, err := json.Marshal(row)
		if err != nil || len(raw) > graphRowBytesLimit {
			return fmt.Errorf("rows: строка превысила предел JSON")
		}
	}
	return nil
}

// ClaimGraphJob выдаёт под writer-lock одно задание, допущенное расписанием маршрута.
// Истёкшие выдачи прерываются, изменённые снимки фиксируются до возврата ответа.
func (s Store) ClaimGraphJob(now int64) (GraphClaimResult, error) {
	result := GraphClaimResult{Changed: []GraphUpdate{}}
	err := s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		if index.FaultUntil > now {
			result.Pending = true
			result.NextWakeAt = index.FaultUntil
			return nil
		}
		if err := s.reconcileGraphReservations(root, &index, now, &result.Changed); err != nil {
			return err
		}
		type candidate struct {
			id        string
			createdAt int64
			envelope  graphEnvelope
			snapshot  *graphworkflow.Snapshot
			dirty     bool
		}
		candidates := make([]candidate, 0, len(index.Active))
		kept := make([]string, 0, len(index.Active))
		indexChanged := false
		for _, id := range index.Active {
			envelope, snapshot, err := readGraphRunLocked(root, id)
			if errors.Is(err, os.ErrNotExist) {
				indexChanged = true
				continue
			}
			if err != nil {
				if index.FaultUntil > 0 && now >= index.FaultUntil {
					index.FaultUntil = 0
					indexChanged = true
					continue
				}
				index.FaultUntil = now + graphFaultHorizon
				indexChanged = true
				kept = append(kept, id)
				result.Pending = true
				result.NextWakeAt = index.FaultUntil
				continue
			}
			dirty := snapshot.ExpireExcept(now, func(claimID string) bool {
				return graphReservationFor(&index, claimID) != nil
			})
			if err := snapshot.Advance(); err != nil {
				return err
			}
			if !graphKeepsMarker(snapshot) && !graphHasReservation(&index, id) {
				indexChanged = true
				if dirty {
					if err := s.publishGraphRunLocked(root, id, &envelope, snapshot); err != nil {
						return err
					}
					result.Changed = append(result.Changed, GraphUpdate{ID: id, Revision: envelope.Revision})
				}
				continue
			}
			kept = append(kept, id)
			createdAt := int64(0)
			if raw, err := readTrusted(root, filepath.Join("runs-meta", id+".json"), graphDocumentLimit, ownerMode); err == nil {
				var meta graphRunMeta
				if json.Unmarshal(raw, &meta) == nil {
					createdAt = meta.CreatedAt
				}
			}
			candidates = append(candidates, candidate{id: id, createdAt: createdAt, envelope: envelope, snapshot: snapshot, dirty: dirty})
		}
		slices.SortFunc(candidates, func(left, right candidate) int {
			if left.createdAt != right.createdAt {
				if left.createdAt < right.createdAt {
					return -1
				}
				return 1
			}
			return strings.Compare(left.id, right.id)
		})
		if result.NextWakeAt == 0 {
			for position := range candidates {
				entry := &candidates[position]
				for _, nodeID := range entry.snapshot.Order {
					node := entry.snapshot.Nodes[nodeID]
					if node == nil || node.Status != "ready" || graphReservationOfNode(&index, entry.id, nodeID) != nil {
						continue
					}
					token := graphRandomToken()
					lease, err := entry.snapshot.Acquire(nodeID, token, now)
					if err != nil {
						continue
					}
					rows, err := entry.snapshot.RowsFor(graphworkflow.ResultRef{ID: nodeID, Generation: node.Generation}, 4*1024*1024)
					if err != nil {
						node.Claim = nil
						node.Status = "failed"
						node.ErrorCode = err.Error()
						entry.snapshot.Clock++
						entry.snapshot.Events = append(entry.snapshot.Events, graphworkflow.Event{
							At: entry.snapshot.Clock, Kind: "settle", NodeID: nodeID,
							Generation: node.Generation, ErrorCode: node.ErrorCode,
						})
						if err := entry.snapshot.Advance(); err != nil {
							return err
						}
						entry.dirty = true
						continue
					}
					decl := entry.snapshot.DeclOf(node)
					result.Job = &GraphClaimJob{
						ID: entry.id, NodeID: nodeID, Generation: lease.Generation, ClaimID: lease.ClaimID,
						Kind: node.Kind, Prompt: decl.Prompt, Feedback: node.Feedback,
						ModelRef: entry.snapshot.ModelRef, InputKind: entry.snapshot.Definition.InputKind,
						Rows: rows, ExpiresAt: lease.ExpiresAt,
					}
					entry.dirty = true
					break
				}
				if result.Job != nil {
					break
				}
			}
		}
		for position := range candidates {
			entry := &candidates[position]
			if !entry.dirty {
				continue
			}
			if err := s.publishGraphRunLocked(root, entry.id, &entry.envelope, entry.snapshot); err != nil {
				return err
			}
			result.Changed = append(result.Changed, GraphUpdate{ID: entry.id, Revision: entry.envelope.Revision})
			if !graphKeepsMarker(entry.snapshot) && !graphHasReservation(&index, entry.id) {
				graphUnmarkActive(&index, entry.id)
				indexChanged = true
			}
		}
		if indexChanged {
			index.Active = kept
			if err := publishGraphActive(root, index); err != nil {
				return err
			}
		}
		for position := range candidates {
			entry := &candidates[position]
			if graphClaimCount(entry.snapshot) > 0 || graphReadyCount(entry.snapshot) > 0 {
				result.Pending = true
			}
		}
		return nil
	})
	return result, err
}

// publishGraphRunLocked публикует следующий снимок под уже взятой блокировкой.
func (s Store) publishGraphRunLocked(root *os.Root, id string, envelope *graphEnvelope,
	snapshot *graphworkflow.Snapshot,
) error {
	document, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	envelope.Revision++
	envelope.Document = document
	return publishGraphEnvelope(root, filepath.Join("runs", id+".json"), *envelope, true)
}

// SettleGraphJob принимает результат точной выдачи, а не общую ревизию снимка.
// Переполнение оболочки переформулируется как failed/snapshot_limit без принятия выхода.
func (s Store) SettleGraphJob(result graphworkflow.Settlement, now int64) (GraphUpdate, error) {
	update := GraphUpdate{ID: result.RunID}
	if !graphUUID.MatchString(result.RunID) {
		return update, fmt.Errorf("id: неверный прогон")
	}
	if err := graphValidateSettlement(result); err != nil {
		return update, err
	}
	err := s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		envelope, snapshot, err := readGraphRunLocked(root, result.RunID)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return ErrGraphNotFound
			}
			return ErrGraphBroken
		}
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		if graphReservationFor(&index, result.ClaimID) != nil {
			return fmt.Errorf("settle: выдача принадлежит model helper")
		}
		node := snapshot.Nodes[result.NodeID]
		if node != nil && len(result.Rows) > 0 {
			if err := graphValidateSources(snapshot, node, result.Rows); err != nil {
				return err
			}
		}
		if err := snapshot.Settle(result, now); err != nil {
			return err
		}
		if err := snapshot.Advance(); err != nil {
			return err
		}
		document, err := json.Marshal(snapshot)
		if err != nil {
			return err
		}
		if len(document)+512 > graphDocumentLimit {
			node.Rows = nil
			node.Status = "failed"
			node.ErrorCode = "snapshot_limit"
			node.AcceptedAt = 0
			if err := snapshot.Advance(); err != nil {
				return err
			}
		}
		if err := s.publishGraphRunLocked(root, result.RunID, &envelope, snapshot); err != nil {
			return err
		}
		update.Revision = envelope.Revision
		if !graphKeepsMarker(snapshot) && !graphHasReservation(&index, result.RunID) {
			graphUnmarkActive(&index, result.RunID)
			return publishGraphActive(root, index)
		}
		return nil
	})
	return update, err
}

// ActionGraphRun применяет повтор, решение ворот или паузу под ожидаемой ревизией.
// Активные settle и пауза проходят при лимите операций, новые действия ограничены.
func (s Store) ActionGraphRun(id string, expected uint64, nodeID string, generation uint64,
	action, target, comment string, now int64,
) (GraphUpdate, error) {
	update := GraphUpdate{ID: id}
	if !graphUUID.MatchString(id) {
		return update, fmt.Errorf("id: неверный прогон")
	}
	err := s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		envelope, snapshot, err := readGraphRunLocked(root, id)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return ErrGraphNotFound
			}
			return ErrGraphBroken
		}
		if envelope.Revision != expected {
			return ErrConflict
		}
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		switch action {
		case "pause":
			snapshot.Paused = true
		case "resume":
			snapshot.Paused = false
		case "retry", "approve", "reject":
			if len(snapshot.Events) >= graphEventLimit {
				return errGraphOperationLimit
			}
			node := snapshot.Nodes[nodeID]
			if node == nil || node.Generation != generation {
				return ErrConflict
			}
			switch action {
			case "retry":
				if graphAttemptCount(snapshot, nodeID) >= graphAttemptLimit {
					return errGraphOperationLimit
				}
				if graphReservationOfNode(&index, id, nodeID) != nil {
					return ErrConflict
				}
				if err := snapshot.Retry(nodeID); err != nil {
					return err
				}
			case "approve":
				if err := snapshot.Decide(nodeID, generation, true, "", ""); err != nil {
					return err
				}
			case "reject":
				if len(comment) > 1024 {
					return fmt.Errorf("comment: замечание до 1 КиБ")
				}
				if err := snapshot.Decide(nodeID, generation, false, target, comment); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("action: неизвестное действие")
		}
		if err := snapshot.Advance(); err != nil {
			return err
		}
		keep := graphKeepsMarker(snapshot) || graphHasReservation(&index, id)
		if keep && !slices.Contains(index.Active, id) {
			if len(index.Active) >= graphActiveLimit {
				return errGraphActiveLimit
			}
			// Маркер до снимка позволяет опросу найти работу после обрыва.
			graphMarkActive(&index, id)
			if err := publishGraphActive(root, index); err != nil {
				return err
			}
		}
		if err := s.publishGraphRunLocked(root, id, &envelope, snapshot); err != nil {
			return err
		}
		update.Revision = envelope.Revision
		if !keep {
			graphUnmarkActive(&index, id)
			return publishGraphActive(root, index)
		}
		return nil
	})
	return update, err
}
