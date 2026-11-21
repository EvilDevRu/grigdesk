package control

import (
	"math"
	"regexp"
	"strings"
	"unicode/utf16"

	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
)

type Record map[string]any

type Failure struct {
	Code int
	Text string
}

func (err *Failure) Error() string {
	return err.Text
}

func Usage(message string) error {
	return &Failure{Code: 2, Text: message}
}

var patterns = map[string]*regexp.Regexp{
	"task":          regexp.MustCompile(`^[1-9][0-9]{0,18}$`),
	"profile":       regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`),
	"attempt":       regexp.MustCompile(`^a_[a-f0-9]{32}$`),
	"node":          regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,40}$`),
	"stage":         regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`),
	"key":           regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`),
	"conversation":  regexp.MustCompile(`^c_[a-f0-9]{32}$`),
	"provider":      regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`),
	"board":         regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,127}$`),
	"afterSequence": regexp.MustCompile(`^(0|[1-9][0-9]{0,8})$`),
	"knownRevision": regexp.MustCompile(`^(0|[1-9][0-9]{0,8})$`),
	"timeoutMs":     regexp.MustCompile(`^[1-9][0-9]{0,7}$`),
	"intervalMs":    regexp.MustCompile(`^[1-9][0-9]{0,5}$`),
	"decision":      regexp.MustCompile(`^(approve|reject)$`),
	"doc":           regexp.MustCompile(`^(plan|recon|diag|ship|report|audit|review)$`),
	"source":        regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*@[a-f0-9]{64}$`),
	"digest":        regexp.MustCompile(`^[a-f0-9]{64}$`),
	"visit":         regexp.MustCompile(`^b_[a-f0-9]{32}$`),
	"symbol":        regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`),
	"state":         regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`),
	"uuid": regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-` +
		`[89ab][a-f0-9]{3}-[a-f0-9]{12}$`),
	"runID":     regexp.MustCompile(`^[A-Za-z0-9._-]+$`),
	"requestID": regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`),
}

// Matches проверяет строку полным регулярным выражением заданного поля.
// Нестроковое значение и неизвестное имя схемы не проходят проверку.
func Matches(field string, value any) bool {
	text, ok := value.(string)
	pattern := patterns[field]
	return ok && pattern != nil && pattern.MatchString(text)
}

func Whole(value any) bool {
	number, ok := value.(float64)
	return ok && number >= 0 && number <= 1<<53-1 && math.Trunc(number) == number
}

// Exact закрывает набор входных ключей, сохраняя отсутствие и null раздельно.
// Имена обязательных и необязательных полей передаёт конкретная команда.
func Exact(value any, required, optional string) (Record, error) {
	row, ok := value.(map[string]any)
	if !ok || row == nil {
		return nil, Usage("Нужен JSON-объект.")
	}
	allowed := make(map[string]bool)
	for _, key := range strings.Fields(required) {
		if _, found := row[key]; !found {
			return nil, Usage("Набор полей JSON не соответствует команде pipeline.")
		}
		allowed[key] = true
	}
	for _, key := range strings.Fields(optional) {
		allowed[key] = true
	}
	for key := range row {
		if !allowed[key] {
			return nil, Usage("Набор полей JSON не соответствует команде pipeline.")
		}
	}
	return Record(row), nil
}

// InputText сохраняет строки без обрезки, после проверки длины и управляющих символов.
// Для комментария длина считается в единицах UTF-16 как у прежнего CLI.
func InputText(value any, limit int) bool {
	text, ok := value.(string)
	return ok && localapi.TrimSpace(text) != "" && len(utf16.Encode([]rune(text))) <= limit &&
		strings.IndexFunc(text, func(r rune) bool { return r < 32 && r != '\n' || r == 127 }) < 0
}
