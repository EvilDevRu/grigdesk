package localapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"grigdesk.local/tools/utilities/internal/grigdeskapi"
)

const (
	NetworkError = "Не удалось связаться с GrigDesk."
	TimeoutError = "GrigDesk не ответил за 300 с: операция могла выполниться — " +
		"проверьте результат перед повтором."
)

type RequestSpec struct {
	Method string
	Path   string
	Body   []byte
	JSON   bool
}

type HTTPError struct {
	Text string
}

func (err *HTTPError) Error() string {
	return err.Text
}

// Request применяет настройки транспорта tracker и возвращает полный успешный ответ.
// При транспортном отказе stderr получает только безопасную причину из контракта CLI.
func Request(
	ctx context.Context, connection Connection, spec RequestSpec, idle time.Duration,
) ([]byte, error) {
	if idle == 0 {
		idle = 300 * time.Second
	}

	headers := make(http.Header)
	headers.Set("X-GrigDesk-Token", connection.Token)
	if spec.JSON {
		headers.Set("Content-Type", "application/json")
	}

	response, err := grigdeskapi.Request(ctx, spec.Method, connection.BaseURL+spec.Path, spec.Body,
		grigdeskapi.Policy{Header: headers, IdleTimeout: idle, ReadLimit: responseLimit})
	if err != nil {
		if cause := context.Cause(ctx); cause != nil {
			return nil, cause
		}

		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			return nil, &HTTPError{Text: TimeoutError}
		}
		return nil, &HTTPError{Text: NetworkError}
	}

	if response.Status < 200 || response.Status > 299 {
		return nil, &HTTPError{Text: failureMessage(response, connection.Token)}
	}

	return response.Body, nil
}

// responseLimit оставляет успешный ответ целым, а у JSON-ошибок ограничивает объём причины.
// Тело ошибки с другим Content-Type можно закрыть сразу после заголовков.
func responseLimit(status int, header http.Header) int64 {
	if status >= 200 && status <= 299 {
		return -1
	}
	if strings.Contains(header.Get("Content-Type"), "application/json") {
		return 64 * 1024
	}
	return 0
}

// failureMessage переносит в ошибку только строковое поле message из ограниченного ответа.
// Маскирование и удаление управляющих символов предшествуют обрезке UTF-16.
func failureMessage(response grigdeskapi.Response, token string) string {
	message := ""
	if !response.Truncated && len(response.Body) > 0 {
		var data map[string]json.RawMessage
		if json.Unmarshal(response.Body, &data) == nil {
			var raw string
			if json.Unmarshal(data["message"], &raw) == nil {
				message = sanitizeReason(raw, token)
			}
		}
	}

	prefix := fmt.Sprintf("Запрос к GrigDesk завершился ошибкой HTTP %d", response.Status)
	if message == "" {
		return prefix + "."
	}
	last, _ := utf8.DecodeLastRuneInString(message)
	if strings.ContainsRune(".!?…", last) {
		return prefix + ": " + message
	}
	return prefix + ": " + message + "."
}

// sanitizeReason очищает серверный текст перед передачей человеку или агенту.
// В отличие от байтового среза считает длину так же, как Node-версия команды.
func sanitizeReason(message, token string) string {
	if token != "" {
		message = strings.ReplaceAll(message, token, "***")
	}
	message = strings.Map(func(r rune) rune {
		if r < 0x20 || r >= 0x7f && r <= 0x9f {
			return ' '
		}
		return r
	}, message)
	message = TrimSpace(message)

	units := utf16.Encode([]rune(message))
	if len(units) > 500 {
		return string(utf16.Decode(units[:500])) + "…"
	}
	return message
}
