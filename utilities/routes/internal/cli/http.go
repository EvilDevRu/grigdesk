package cli

import (
	"bytes"
	"context"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"grigdesk.local/tools/utilities/internal/grigdeskapi"
)

type commandError struct {
	code int
	text string
}

func (err *commandError) Error() string {
	return err.text
}

func usage(text string) error {
	return &commandError{code: 1, text: text}
}

type invocation struct {
	ctx     context.Context
	profile string
	flags   flags
	stdout  io.Writer
	stderr  io.Writer
}

// call выполняет HTTP с токеном и общим сроком на соединение и чтение ответа.
// Для мутации 3xx возвращается как отказ сервера, без перехода на другой URL.
func (run invocation) call(method, pathname string, body any) (json.RawMessage, error) {
	token := resolveToken(run.flags)
	if token == "" {
		return nil, usage("CLI-токен не найден: --token, GRIGDESK_CLI_TOKEN или файл cli-token")
	}
	headers := make(http.Header)
	headers.Set("X-GrigDesk-Token", token)
	var payload []byte
	if body != nil {
		var err error
		payload, err = jsonv2.Marshal(body)
		if err != nil {
			return nil, err
		}
		headers.Set("Content-Type", "application/json")
	}

	base := baseURL(run.flags)
	duration, valid := timeoutMillis(run.flags)
	if !valid {
		return nil, &commandError{code: 3, text: "Сервер GrigDesk недоступен (" + base + "): неверный таймаут"}
	}
	ctx, cancel := context.WithTimeout(run.ctx, duration)
	defer cancel()
	response, err := grigdeskapi.Request(ctx, method, base+pathname, payload, grigdeskapi.Policy{
		Header:              headers,
		FollowReadRedirects: true,
	})
	if err != nil {
		reason := "fetch failed"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			reason = fmt.Sprintf("таймаут %d мс", duration.Milliseconds())
		}
		return nil, &commandError{code: 3, text: fmt.Sprintf("Сервер GrigDesk недоступен (%s): %s", base, reason)}
	}

	value := safeParse(response.Body)
	if response.Status >= 200 && response.Status < 300 {
		return value, nil
	}
	if err := run.print(value); err != nil {
		return nil, err
	}
	return nil, responseError(response.Status)
}

// responseError переводит статус отказа в код терминальной команды.
// Для неизвестного статуса выводится исходное число, включая перенаправления записи.
func responseError(status int) error {
	switch status {
	case 404:
		return &commandError{code: 2, text: "не найдено"}
	case 409:
		return &commandError{code: 4, text: "конфликт ревизии: перечитайте документ и повторите"}
	default:
		return &commandError{code: 5, text: fmt.Sprintf("сервер вернул %d", status)}
	}
}

// resolveToken читает явный токен, экспорт или один выбранный файл по порядку.
// Пустой явный флаг остаётся пустым значением, без подстановки из соседней настройки.
func resolveToken(f flags) string {
	if token, ok := f.single("token"); ok {
		return token
	}
	if token := os.Getenv("GRIGDESK_CLI_TOKEN"); token != "" {
		return token
	}

	file, ok := f.single("token-file")
	if !ok {
		file, ok = os.LookupEnv("GRIGDESK_CLI_TOKEN_PATH")
	}
	if !ok {
		root := os.Getenv("GRIGDESK_HOME")
		if root == "" {
			home, _ := os.UserHomeDir()
			root = filepath.Join(home, ".grigdesk")
		}
		file = filepath.Join(root, "state", "cli-token")
	}
	text, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(text))
}

// baseURL выбирает явное значение или адрес из окружения, очищенный по краям.
// При пустых настройках запрос идёт на локальный порт GrigDesk.
func baseURL(f flags) string {
	base, _ := f.single("base")
	if base == "" {
		base = strings.TrimSpace(os.Getenv("GRIGDESK_BASE_URL"))
	}
	if base != "" {
		return strings.TrimSuffix(base, "/")
	}
	port := os.Getenv("GRIGDESK_PORT")
	if port == "" {
		port = "8140"
	}
	return "http://127.0.0.1:" + port
}

// timeoutMillis сохраняет умолчание для отсутствующего и неположительного значения.
// Положительный срок переводится в длительность только в диапазоне таймера Node.
func timeoutMillis(f flags) (time.Duration, bool) {
	value, ok := f.single("timeout")
	if list := f["timeout"]; !ok && len(list) == 1 {
		value = "1"
	}
	millis, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || millis <= 0 || math.IsNaN(millis) {
		return 30 * time.Second, true
	}
	if millis > math.MaxUint32 || math.Trunc(millis) != millis {
		return 0, false
	}
	return time.Duration(millis) * time.Millisecond, true
}

// safeParse оставляет полный JSON. Некорректный ответ возвращается коротким полем raw.
// Пустое тело печатается как JSON null, а ответ Fetch лишён начального BOM.
func safeParse(body []byte) json.RawMessage {
	body = bytes.TrimPrefix(body, []byte("\ufeff"))
	if len(body) == 0 {
		return json.RawMessage("null")
	}
	if json.Valid(body) {
		return body
	}

	units := utf16.Encode([]rune(string(body)))
	raw := string(utf16.Decode(units[:min(len(units), 2000)]))
	value, _ := jsonv2.Marshal(struct {
		Raw string `json:"raw"`
	}{Raw: raw})
	return value
}

// print формирует один JSON с двумя пробелами отступа и одним конечным LF.
// Уже полученный JSON сохраняет порядок полей ответа сервера.
func (run invocation) print(value any) error {
	compact, err := jsonv2.Marshal(value)
	if err != nil {
		return err
	}
	var formatted bytes.Buffer
	if err := json.Indent(&formatted, compact, "", "  "); err != nil {
		return err
	}
	formatted.WriteByte('\n')
	_, err = run.stdout.Write(formatted.Bytes())
	return err
}

// show печатает удачный ответ после завершения полного HTTP-чтения.
// При отказе JSON уже был напечатан в call, повторный вывод отсутствует.
func (run invocation) show(method, pathname string, body any) error {
	value, err := run.call(method, pathname, body)
	if err != nil {
		return err
	}
	return run.print(value)
}
