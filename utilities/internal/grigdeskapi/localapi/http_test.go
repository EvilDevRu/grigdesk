package localapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const httpToken = "secret-token-value"

func fixtureConnection(server *httptest.Server) Connection {
	return Connection{BaseURL: server.URL, Token: httpToken}
}

// requireHTTPError проверяет тип отказа и сообщение независимо от статуса HTTP.
// Секрет из запроса не должен появиться в сообщении ни при одном исходе.
func requireHTTPError(t *testing.T, err error, want string) {
	t.Helper()
	var failure *HTTPError
	if !errors.As(err, &failure) || failure.Error() != want || strings.Contains(failure.Error(), httpToken) {
		t.Fatalf("получено %v, ожидали %q", err, want)
	}
}

// TestHTTPFullResponse сохраняет байты успешного ответа независимо от статуса 2xx.
// Тест читает несколько чанков и отдельно проверяет пустой ответ 204.
func TestHTTPFullResponse(t *testing.T) {
	body := []byte("{\"title\":\"Задача 🌍\",\"note\":\"  пробелы  \"}\n")
	for _, status := range []int{200, 201, 204, 299} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.WriteHeader(status)
			if status != 204 {
				_, _ = w.Write(body[:13])
				w.(http.Flusher).Flush()
				_, _ = w.Write(body[13:])
			}
		}))
		method := http.MethodGet
		want := body
		if status == 204 {
			method, want = http.MethodPost, nil
		}
		got, err := Request(t.Context(), fixtureConnection(server), RequestSpec{Method: method}, time.Second)
		server.Close()
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("статус %d: ответ %q, ошибка %v", status, got, err)
		}
	}
}

// TestHTTPStatus проверяет HTTP ошибки и отсутствие повторной выдачи токена после redirect.
// HTML и JSON без поля message не попадают в ответ команды.
func TestHTTPStatus(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		t.Error("redirect получил второй запрос")
	}))
	defer target.Close()

	for _, status := range []int{301, 302, 307, 400, 401, 403, 404, 500, 502} {
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			calls.Add(1)
			payload := `{"error":"секрет"}`
			if status%2 == 0 {
				w.Header().Set("Content-Type", "text/html")
				payload = "<html>секрет</html>"
			} else {
				w.Header().Set("Content-Type", "application/json")
			}
			w.Header().Set("Location", target.URL+"/elsewhere")
			w.WriteHeader(status)
			_, _ = io.WriteString(w, payload)
		}))
		got, err := Request(t.Context(), fixtureConnection(server),
			RequestSpec{Method: http.MethodGet, Path: "/api/tracker/dashboard"}, time.Second)
		server.Close()
		requireHTTPError(t, err, fmt.Sprintf("Запрос к GrigDesk завершился ошибкой HTTP %d.", status))
		if len(got) != 0 || calls.Load() != 1 {
			t.Fatalf("статус %d: ответ %q, число запросов %d", status, got, calls.Load())
		}
	}
}

// TestHTTPReason проверяет обработку и маскирование message из JSON.
// Остальные поля, большие ответы, несоответствие типа и повреждённый JSON скрыты.
func TestHTTPReason(t *testing.T) {
	const prefix = "Запрос к GrigDesk завершился ошибкой HTTP 400"
	for _, test := range []struct {
		body any
		mime string
		want string
	}{
		{map[string]any{
			"error": "b24_not_configured", "message": "B24 не настроен: заполните логин/пароль в Настройках.",
		},
			"application/json; charset=utf-8", prefix + ": B24 не настроен: заполните логин/пароль в Настройках."},
		{map[string]any{"message": "строка1\nстрока2\x1b[31m"}, "application/json",
			prefix + ": строка1 строка2 [31m."},
		{map[string]any{"message": strings.Repeat("я", 600)}, "application/json",
			prefix + ": " + strings.Repeat("я", 500) + "…"},
		{map[string]any{"message": 42}, "application/json", prefix + "."},
		{map[string]any{"Message": "не то поле"}, "application/json", prefix + "."},
		{map[string]any{"message": "не JSON-тип"}, "text/plain", prefix + "."},
		{map[string]any{"message": "большое тело", "pad": strings.Repeat("x", 70*1024)},
			"application/json", prefix + "."},
		{`{"message":`, "application/json", prefix + "."},
		{map[string]any{"message": "токен " + httpToken + "; снова " + httpToken}, "application/json",
			prefix + ": токен ***; снова ***."},
		{map[string]any{"message": "до\x00\x1f\x7f\u0080\u009b31m\u009fпосле"}, "application/json",
			prefix + ": до     31m после."},
		{map[string]any{"message": strings.Repeat("я", 498) + httpToken + " хвост"}, "application/json",
			prefix + ": " + strings.Repeat("я", 498) + "**…"},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("Content-Type", test.mime)
			w.WriteHeader(400)
			if raw, ok := test.body.(string); ok {
				_, _ = io.WriteString(w, raw)
			} else {
				_ = json.NewEncoder(w).Encode(test.body)
			}
		}))
		_, err := Request(t.Context(), fixtureConnection(server), RequestSpec{Method: http.MethodGet}, time.Second)
		server.Close()
		requireHTTPError(t, err, test.want)
	}
}

// TestHTTPWire проверяет заголовки и байты JSON через настоящий локальный HTTP.
// Прокси окружения не участвует даже для имени localhost.
func TestHTTPWire(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		t.Error("запрос ушёл к прокси")
	}))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("http_proxy", proxy.URL)
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")

	for _, spec := range []RequestSpec{
		{Method: http.MethodGet, Path: "/api/tracker/dashboard"},
		{Method: http.MethodPost, Path: "/api/tracker/task/1/renew"},
		{Method: http.MethodPost, Path: "/api/tracker/task/1/comment", Body: []byte(`{"text":"т"}`), JSON: true},
		{Method: http.MethodPost, Path: "/api/tracker/tasks", Body: []byte("{\"title\":\"т\"}\n"), JSON: true},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			body, err := io.ReadAll(req.Body)
			if err != nil || !bytes.Equal(body, spec.Body) ||
				req.URL.RequestURI() != spec.Path || req.Method != spec.Method {
				t.Errorf("получено %s %s %q (%v)", req.Method, req.URL.RequestURI(), body, err)
			}
			mime := req.Header.Get("Content-Type")
			if spec.JSON && (mime != "application/json" || req.ContentLength != int64(len(spec.Body))) ||
				!spec.JSON && (mime != "" || req.ContentLength != 0) {
				t.Errorf("Content-Type=%q, Content-Length=%d", mime, req.ContentLength)
			}
			if req.Header.Get("X-GrigDesk-Token") != httpToken {
				t.Error("заголовок токена отсутствует")
			}
			_, _ = io.WriteString(w, "{}")
		}))
		_, err := Request(t.Context(), fixtureConnection(server), spec, time.Second)
		server.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
}

// TestHTTPBreak проверяет отказ до заголовков, посреди успешного ответа и на закрытом порту.
// Мутация при разрыве связи отправляется единожды, частичный ответ не возвращается.
func TestHTTPBreak(t *testing.T) {
	for _, partial := range []bool{false, true} {
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			calls.Add(1)
			if partial {
				w.Header().Set("Content-Length", "100000")
				_, _ = io.WriteString(w, `{"partial":`)
				w.(http.Flusher).Flush()
			}
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Close()
		}))
		body, err := Request(t.Context(), fixtureConnection(server),
			RequestSpec{Method: http.MethodPost, Body: []byte("{}"), JSON: true}, time.Second)
		server.Close()
		requireHTTPError(t, err, NetworkError)
		if calls.Load() != 1 || len(body) != 0 {
			t.Fatalf("часть %v: запросов %d, тело %q", partial, calls.Load(), body)
		}
		_, err = Request(t.Context(), fixtureConnection(server), RequestSpec{Method: http.MethodGet}, time.Second)
		requireHTTPError(t, err, NetworkError)
	}
}

// TestHTTPIdle проверяет один срок простоя до заголовков и при чтении тел 200 и 502.
// После начала вызова fixture ждёт закрытия соединения, не имитируя отказ очередной попыткой.
func TestHTTPIdle(t *testing.T) {
	for _, status := range []int{0, 200, 502} {
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			calls.Add(1)
			_, _ = io.Copy(io.Discard, req.Body)
			if status != 0 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"partial":`)
				w.(http.Flusher).Flush()
			}
			<-req.Context().Done()
		}))
		_, err := Request(t.Context(), fixtureConnection(server),
			RequestSpec{Method: http.MethodPost, Path: "/api/tracker/tasks", Body: []byte(`{}`), JSON: true},
			100*time.Millisecond)
		server.Close()
		requireHTTPError(t, err, TimeoutError)
		if calls.Load() != 1 {
			t.Fatalf("статус %d: запросов %d", status, calls.Load())
		}
	}
}

// TestHTTPProgress отличает срок простоя от дедлайна контекста.
// Чанки продлевают первый срок, а запрос после отмены получает её причину.
func TestHTTPProgress(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		for range 8 {
			select {
			case <-req.Context().Done():
				return
			case <-time.After(20 * time.Millisecond):
				_, _ = io.WriteString(w, "a")
				w.(http.Flusher).Flush()
			}
		}
	}))
	defer server.Close()

	payload, err := Request(t.Context(), fixtureConnection(server), RequestSpec{Method: http.MethodGet},
		100*time.Millisecond)
	if err != nil || string(payload) != "aaaaaaaa" {
		t.Fatalf("получено %q, ошибка %v", payload, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	_, err = Request(ctx, fixtureConnection(server), RequestSpec{Method: http.MethodGet}, time.Second)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("дедлайн контекста потерян: %v", err)
	}
}
