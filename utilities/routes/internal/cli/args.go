package cli

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type flags map[string][]*string

var (
	profilePattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,40}$`)
	operationPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)
	hashPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	digits           = regexp.MustCompile(`^[0-9]+$`)
)

// parseFlags сохраняет флаги с отдельным значением и с записью --ключ=значение.
// Повторённые значения хранятся по порядку для profile-config set.
func parseFlags(args []string) flags {
	result := make(flags)
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "--") {
			continue
		}
		key, value, hasValue := strings.Cut(arg[2:], "=")
		if !hasValue && index+1 < len(args) && !strings.HasPrefix(args[index+1], "--") {
			index++
			value, hasValue = args[index], true
		}
		if hasValue {
			result[key] = append(result[key], &value)
		} else {
			result[key] = []*string{nil}
		}
	}
	return result
}

func (f flags) single(key string) (string, bool) {
	if values := f[key]; len(values) == 1 && values[0] != nil {
		return *values[0], true
	}
	return "", false
}

func (f flags) valueOr(key, fallback string) string {
	if value, ok := f.single(key); ok {
		return value
	}
	return fallback
}

func (f flags) required(key string) (string, error) {
	if value, ok := f.single(key); ok && value != "" {
		return value, nil
	}
	return "", usage("нужен --" + key)
}

// revision проверяет число, которое JavaScript и сервер одинаково представляют без округления.
// Значение берётся из аргументов, а свежий GET используется только для сравнения.
func (f flags) revision(key string, lower int64) (int64, error) {
	raw, err := f.required(key)
	if err != nil {
		return 0, err
	}
	revision, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || !digits.MatchString(raw) || revision < lower || revision > 1<<53-1 {
		return 0, usage("неверный --" + key)
	}
	return revision, nil
}

// expected принимает конкретный current или явно заявленное отсутствие каталога.
// Пара ревизия и хеш проверяется до первой сетевой записи.
func (f flags) expected() (int64, *string, error) {
	revision, err := f.revision("expected-source-revision", 0)
	if err != nil {
		return 0, nil, err
	}
	hash, err := f.required("expected-catalog-hash")
	if err != nil {
		return 0, nil, err
	}
	if hash == "none" {
		return revision, nil, nil
	}
	if !hashPattern.MatchString(hash) {
		return 0, nil, usage("нужен --expected-catalog-hash <hash|none>")
	}
	return revision, &hash, nil
}

func (f flags) requireYes() error {
	if values := f["yes"]; len(values) != 1 || values[0] != nil {
		return usage("действие меняет каталог: добавьте --yes")
	}
	return nil
}

// showID сохраняет принятый старой командой текст --draft для show.
// Остальные команды требуют одно значение и кодируют его как сегмент.
func (f flags) showID() (string, error) {
	values := f["draft"]
	if len(values) == 0 {
		return "", usage("нужен --draft <id>")
	}
	parts := make([]string, 0, len(values))
	for _, value := range values {
		parts = append(parts, flagText(value))
	}
	if len(parts) == 1 && parts[0] == "" {
		return "", usage("нужен --draft <id>")
	}
	return strings.Join(parts, ","), nil
}

func flagText(value *string) string {
	if value == nil {
		return fmt.Sprint(true)
	}
	return *value
}
