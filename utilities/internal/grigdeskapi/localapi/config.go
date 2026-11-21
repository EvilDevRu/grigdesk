package localapi

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/nationallibraryofnorway/whatwg-url/url"
)

type Connection struct {
	BaseURL string
	Token   string
}

type ConfigIO struct {
	GetHome  func() string
	ReadText func(string) (string, error)
}

var (
	pathAlphabet = regexp.MustCompile(`^/[A-Za-z0-9._+/@,=:\-]*$`)
	decimalPort  = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
	addressError = errors.New("Некорректный адрес GrigDesk: нужен HTTP(S) URL без учётных данных и query.")
	portError    = errors.New("Некорректный порт GrigDesk: нужно целое число от 1 до 65535.")
)

// ResolveConnection вычисляет адрес и токен до обращения к сети.
// Полностью заданная пара из окружения не читает домашнюю папку и настройки.
func ResolveConnection(env map[string]string, io ConfigIO) (Connection, error) {
	baseURL := env["GRIGDESK_URL"]
	token := env["GRIGDESK_TOKEN"]
	if baseURL != "" && token != "" {
		return checkedConnection(baseURL, token)
	}

	home := env["HOME"]
	if home == "" {
		home = io.GetHome()
	}
	root, err := dataHome(env["GRIGDESK_HOME"], home)
	if err != nil {
		return Connection{}, err
	}

	settings, err := readSettings(env, root, io.ReadText)
	if err != nil {
		return Connection{}, err
	}
	if baseURL != "" {
		baseURL, err = checkedURL(baseURL)
	} else {
		baseURL, err = urlFromPort(setting(env, settings, "GRIGDESK_PORT"))
	}
	if err != nil {
		return Connection{}, err
	}

	if token == "" {
		token, err = fileToken(env, settings, root, io.ReadText)
		if err != nil {
			return Connection{}, err
		}
	}
	if err := checkToken(token); err != nil {
		return Connection{}, err
	}

	return Connection{BaseURL: baseURL, Token: token}, nil
}

// checkedConnection проверяет полностью явные настройки в исходном порядке.
// Ошибка адреса предшествует проверке значения токена.
func checkedConnection(rawURL, token string) (Connection, error) {
	baseURL, err := checkedURL(rawURL)
	if err != nil {
		return Connection{}, err
	}
	if err := checkToken(token); err != nil {
		return Connection{}, err
	}
	return Connection{BaseURL: baseURL, Token: token}, nil
}

// checkedURL разбирает адрес по правилам URL исходного CLI.
// Даже пустые query и fragment запрещены, чтобы не менять смысл дописываемого пути.
func checkedURL(value string) (string, error) {
	if strings.ContainsAny(value, "?#") {
		return "", addressError
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme() != "http" && parsed.Scheme() != "https" {
		return "", addressError
	}
	if parsed.Username() != "" || parsed.Password() != "" {
		return "", addressError
	}
	return strings.TrimRight(parsed.Href(false), "/"), nil
}

func checkToken(token string) error {
	if TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n\x00") {
		return errors.New("Некорректный токен GrigDesk.")
	}
	return nil
}

// dataHome проверяет алфавит и сегменты исходного пути до нормализации.
// Иначе файловая система могла бы скрыть запрещённые сегменты . или ...
func dataHome(override, home string) (string, error) {
	const message = "GRIGDESK_HOME должен быть абсолютным путём из латинских букв, цифр и символов " +
		". _ + - / @ , = : — получено: "
	root := override
	if root == "" {
		root = strings.TrimRight(home, "/") + "/.grigdesk"
	}
	root = strings.TrimRight(root, "/")

	valid := pathAlphabet.MatchString(root)
	for part := range strings.SplitSeq(root, "/") {
		if part == "." || part == ".." {
			valid = false
			break
		}
	}
	if override == "" {
		if !strings.HasPrefix(home, "/") || !valid {
			return "", errors.New(message + home + "; задайте GRIGDESK_HOME")
		}
	} else if !valid {
		return "", errors.New(message + override)
	}

	return root, nil
}

// readSettings читает один файл, отсутствие которого соответствует пустым настройкам.
// Файл не может переназначить свой путь или корень данных.
func readSettings(
	env map[string]string, root string, read func(string) (string, error),
) (map[string]string, error) {
	file := env["GRIGDESK_ENV_FILE"]
	if file == "" {
		file = root + "/.env"
	}
	text, err := read(file)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("Не удалось прочитать настройки: %s.", file)
	}

	settings := ParseDotenv(text)
	for _, key := range []string{"GRIGDESK_HOME", "GRIGDESK_ENV_FILE"} {
		if _, exists := settings[key]; exists {
			return nil, fmt.Errorf("Ключ %s запрещён в файле настроек.", key)
		}
	}
	return settings, nil
}

func setting(env, file map[string]string, key string) string {
	if value, exists := env[key]; exists {
		return value
	}
	return file[key]
}

// fileToken сохраняет относительные и абсолютные явные пути без пересчёта.
// Пустой экспорт перекрывает значение из файла и выбирает штатный путь.
func fileToken(
	env, settings map[string]string, root string, read func(string) (string, error),
) (string, error) {
	file := setting(env, settings, "GRIGDESK_CLI_TOKEN_PATH")
	if file == "" {
		file = root + "/state/cli-token"
	}
	text, err := read(file)
	token := TrimSpace(text)
	if err != nil || token == "" {
		return "", fmt.Errorf("Нет токена: %s.", file)
	}
	return token, nil
}

// urlFromPort использует умолчание для нуля или NaN, как resolveRuntimeSettings.
// Остальные числа должны быть целыми и попадать в диапазон сетевых портов.
func urlFromPort(value string) (string, error) {
	port := numberFromSetting(TrimSpace(value))
	if port == 0 || math.IsNaN(port) {
		port = 8140
	}
	if port < 1 || port > 65535 || port != math.Trunc(port) {
		return "", portError
	}
	return "http://localhost:" + strconv.Itoa(int(port)), nil
}

// numberFromSetting распознаёт числовые формы JavaScript Number для настройки порта.
// Синтаксически неверное значение остаётся NaN и обрабатывается вызывающим.
func numberFromSetting(value string) float64 {
	if value == "Infinity" || value == "+Infinity" || value == "-Infinity" {
		number, _ := strconv.ParseFloat(value, 64)
		return number
	}
	if decimalPort.MatchString(value) {
		number, _ := strconv.ParseFloat(value, 64)
		return number
	}
	if len(value) < 3 || value[0] != '0' {
		return math.NaN()
	}

	base := 0
	switch value[1] {
	case 'x', 'X':
		base = 16
	case 'o', 'O':
		base = 8
	case 'b', 'B':
		base = 2
	default:
		return math.NaN()
	}
	number, err := strconv.ParseUint(value[2:], base, 64)
	if errors.Is(err, strconv.ErrRange) {
		return math.Inf(1)
	}
	if err != nil {
		return math.NaN()
	}
	return float64(number)
}

// TrimSpace воспроизводит набор пробельных символов JavaScript String.trim.
// Через него проверяются значения из аргументов, настроек и ответов.
func TrimSpace(text string) string {
	return strings.TrimFunc(text, func(r rune) bool {
		return r == '\ufeff' || r != '\u0085' && unicode.IsSpace(r)
	})
}
