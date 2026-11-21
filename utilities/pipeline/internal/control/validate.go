package control

import (
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
)

// Validate выбирает проверку по закрытому имени команды и неизменённым аргументам.
// После успеха исходный JSON передаётся вызывающим без выбора latest или default.
func Validate(command string, values map[string]string, value any) error {
	switch command {
	case "launch":
		return launch(value)
	case "stop", "resume":
		if row, ok := value.(map[string]any); ok {
			if _, exists := row["expectedPrelude"]; exists {
				return prelude(value)
			}
		}
		return cursor(value, values)
	case "bootstrap-answer":
		return bootstrap(value)
	case "runner-set":
		return runnerSettings(value, values["task"])
	default:
		return cursor(value, values)
	}
}

// Mobile принимает точный снимок головы, привязанный к профилю и попытке.
// Вызывающий сервер сам проверяет, совпадает ли снимок с текущим состоянием.
func Mobile(value any) (Record, error) {
	row, err := Exact(value, "profile attempt node state stop sequence headEventHash orchPid terminal", "")
	if err != nil {
		return nil, err
	}
	if !Matches("profile", row["profile"]) || !Matches("attempt", row["attempt"]) ||
		!Matches("state", row["state"]) || !Matches("digest", row["headEventHash"]) ||
		!Whole(row["sequence"]) || !Whole(row["orchPid"]) {
		return nil, Usage("Некорректный exact снимок попытки.")
	}
	for _, key := range []string{"node", "stop", "terminal"} {
		if row[key] != nil && !Matches("symbol", row[key]) {
			return nil, Usage("Некорректный exact снимок попытки.")
		}
	}
	return row, nil
}

// launch проверяет явно прочитанные профиль, маршрут, источник и два отпечатка.
// Допустимые дополнительные поля передаются как есть.
func launch(value any) error {
	row, err := Exact(value, "profile route source expectedCatalogHash expectedLaunch",
		"title description acceptanceCriteria sourceUrl runnerPrimary deliveryTargets "+
			"instrumentationFiles diagnosisKind diagnosisSignal")
	if err != nil {
		return err
	}
	if !Matches("profile", row["profile"]) || !Matches("node", row["route"]) ||
		!Matches("source", row["source"]) || !Matches("digest", row["expectedCatalogHash"]) ||
		!Matches("digest", row["expectedLaunch"]) {
		return Usage("Запуску нужны явные profile/route/source и SHA256 прочитанных вариантов.")
	}
	return nil
}

// cursor проверяет условия управления без подмены снимка после конфликта.
// Документальное основание сравнивается на сервере по прочитанному хешу.
func cursor(value any, values map[string]string) error {
	row, err := Exact(value, "expectedMobile", "comment expectedBasis")
	if err != nil {
		return err
	}
	if _, err := Mobile(row["expectedMobile"]); err != nil {
		return err
	}
	comment, hasComment := row["comment"]
	if values["key"] != "" && (values["decision"] != "approve" || hasComment) && !InputText(comment, 20000) {
		return Usage("Текст пуст, слишком длинный или повреждён.")
	}
	if snapshot, exists := row["expectedBasis"]; exists {
		basis, err := Exact(snapshot, "name hash", "")
		if err != nil {
			return err
		}
		name, _ := basis["name"].(string)
		if !slices.Contains([]string{"plan", "report", "diag"}, name) || !Matches("digest", basis["hash"]) {
			return Usage("Неверный отпечаток документа.")
		}
	}
	return nil
}

// prelude проверяет только форму снимка подготовительной фазы.
// Стадийная identity и bootstrap identity не могут участвовать в одном запросе.
func prelude(value any) error {
	row, err := Exact(value, "expectedPrelude", "")
	if err != nil {
		return err
	}
	identity, err := Exact(row["expectedPrelude"], "profile attempt orchPid bootstrap", "")
	if err != nil {
		return err
	}
	if !Matches("profile", identity["profile"]) || !Matches("attempt", identity["attempt"]) ||
		!Whole(identity["orchPid"]) {
		return Usage("Некорректная identity подготовительной фазы.")
	}
	if identity["bootstrap"] == nil {
		return nil
	}
	stop, err := Exact(identity["bootstrap"], "visitId stopHash state decisionHash", "")
	if err != nil {
		return err
	}
	state, _ := stop["state"].(string)
	if !Matches("visit", stop["visitId"]) || !Matches("digest", stop["stopHash"]) ||
		!slices.Contains([]string{"waiting", "answered", "running"}, state) ||
		stop["decisionHash"] != nil && !Matches("digest", stop["decisionHash"]) {
		return Usage("Некорректная bootstrap identity.")
	}
	return nil
}

// bootstrap принимает полный текст для точно указанного визита scout.
// TAB разрешён, предел длины применяется к Unicode code points.
func bootstrap(value any) error {
	row, err := Exact(value, "profile attempt phase node visitId stopHash answer", "")
	if err != nil {
		return err
	}
	if row["phase"] != "bootstrap" || row["node"] != "scout" || !Matches("profile", row["profile"]) ||
		!Matches("attempt", row["attempt"]) || !Matches("visit", row["visitId"]) ||
		!Matches("digest", row["stopHash"]) {
		return Usage("Некорректная identity bootstrap.")
	}
	answer, ok := row["answer"].(string)
	if !ok || localapi.TrimSpace(answer) == "" || utf8.RuneCountInString(answer) > 20000 ||
		strings.IndexFunc(answer, func(r rune) bool { return r < 32 && r != '\t' && r != '\n' || r == 127 }) >= 0 {
		return Usage("Некорректный текст ответа bootstrap.")
	}
	return nil
}

var catalogRevision = regexp.MustCompile(`^[^\r\n\x{2028}\x{2029}]{1,256}$`)

// runnerSettings проверяет полный набор CAS-ожиданий, запущенную пару id/epoch и selection.
// Null и пустой effort остаются разными значениями.
func runnerSettings(value any, task string) error {
	failure := Usage("Некорректный exact DTO настроек этапа.")
	required := "identity expectedRevision expectedRun catalogRevision requestId mode selection"
	row, err := Exact(value, required, "")
	if err != nil {
		return failure
	}
	identity, err := Exact(row["identity"], "task profile attempt node stage", "")
	if err != nil || identity["task"] != task || !Matches("task", identity["task"]) ||
		!Matches("profile", identity["profile"]) || !Matches("attempt", identity["attempt"]) ||
		!Matches("node", identity["node"]) || !Matches("stage", identity["stage"]) {
		return failure
	}
	catalog, _ := row["catalogRevision"].(string)
	if !Whole(row["expectedRevision"]) || !catalogRevision.MatchString(catalog) ||
		!Matches("requestID", row["requestId"]) || row["mode"] != "next" && row["mode"] != "restart" {
		return failure
	}
	if row["expectedRun"] != nil {
		run, err := Exact(row["expectedRun"], "id epoch", "")
		if err != nil || !Matches("runID", run["id"]) || !Whole(run["epoch"]) || run["epoch"] == float64(0) {
			return failure
		}
	}
	if !runnerSelection(row["selection"]) {
		return failure
	}
	return nil
}

// runnerSelection учитывает отдельно основного и параметризуемого исполнителя.
// Строковые опции проверяются без переписывания или автоподбора.
func runnerSelection(value any) bool {
	row, err := Exact(value, "primary parametersFor model effort", "")
	if err != nil || row["primary"] != nil && !Matches("provider", row["primary"]) ||
		!Matches("provider", row["parametersFor"]) {
		return false
	}
	for _, key := range []string{"model", "effort"} {
		if row[key] == nil {
			continue
		}
		value, ok := row[key].(string)
		if !ok || len(utf16.Encode([]rune(value))) > 2048 || strings.IndexFunc(value, func(r rune) bool {
			return r < 32
		}) >= 0 {
			return false
		}
	}
	return true
}
