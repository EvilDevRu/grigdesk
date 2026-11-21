package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/internal/grigdeskapi"
)

type Session struct {
	Origin  string
	Cookie  string
	Timeout time.Duration
}

var sessionUnavailable = errors.New("Не удалось войти по локальному ключу окна. Проверьте запущенный домашний сервер.")

func localWindowKey(settings Settings) string {
	port, err := strconv.Atoi(settings.Port)
	if err != nil || port < 1 || port > 65535 {
		return ""
	}
	if override := settings.WindowKey; override != "" {
		base := filepath.Base(override)
		if filepath.IsAbs(override) && !strings.HasSuffix(override, "/") && base != "." && base != ".." &&
			!strings.ContainsRune(override, 0) {
			return override
		}
		return ""
	}
	if _, explicit := settings.Env["GRIGDESK_WINDOW_KEY_PATH"]; explicit {
		return ""
	}
	runtime, explicit := settings.Env["XDG_RUNTIME_DIR"]
	if explicit && (!filepath.IsAbs(runtime) || strings.ContainsRune(runtime, 0)) {
		return ""
	}
	if !explicit {
		runtime = "/run/user/" + strconv.Itoa(os.Getuid())
	}
	return filepath.Join(runtime, "grigdesk", "window-key-"+settings.Port)
}

// SignIn меняет локальный ключ окна на короткую cookie без CLI bearer.
func SignIn(ctx context.Context, settings Settings) (Session, error) {
	file := localWindowKey(settings)
	if file == "" {
		return Session{}, sessionUnavailable
	}
	data, err := os.ReadFile(file)
	if err != nil || strings.TrimSpace(string(data)) == "" {
		return Session{}, sessionUnavailable
	}
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	header := make(http.Header)
	header.Set("X-GrigDesk-Window-Key", strings.TrimSpace(string(data)))
	response, err := grigdeskapi.Request(bounded, http.MethodPost, settings.Origin+"/api/auth/window-session?short=1",
		nil, grigdeskapi.Policy{Header: header, ReadLimit: func(int, http.Header) int64 { return 0 }})
	if err != nil || response.Status < 200 || response.Status >= 300 {
		return Session{}, sessionUnavailable
	}
	cookie, _, _ := strings.Cut(response.Header.Get("Set-Cookie"), ";")
	if cookie == "" {
		return Session{}, sessionUnavailable
	}
	return Session{Origin: settings.Origin, Cookie: cookie}, nil
}

type APIError struct {
	Code    string `json:"error"`
	Message string `json:"message"`
	Status  int    `json:"-"`
}

func (problem *APIError) Error() string {
	if problem.Message != "" {
		return problem.Message
	}
	return "Запрос к серверу не выполнен."
}

// Request передаёт cookie только заданному loopback API и ограничивает тело ответа.
func (session Session) Request(ctx context.Context, method, path, contentType string, body []byte) ([]byte, error) {
	timeout := session.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	bounded, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	header := make(http.Header)
	header.Set("Cookie", session.Cookie)
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	response, err := grigdeskapi.Request(bounded, method, session.Origin+path, body, grigdeskapi.Policy{
		Header: header, ReadLimit: func(int, http.Header) int64 { return 2 << 20 },
	})
	if err != nil || response.Truncated {
		return nil, errors.New("Не удалось прочитать ответ локального сервера.")
	}
	if response.Status < 200 || response.Status >= 300 {
		failure := &APIError{Status: response.Status}
		_ = json.Unmarshal(response.Body, failure)
		return nil, failure
	}
	return response.Body, nil
}

func (session Session) JSON(ctx context.Context, method, path string, input, output any) error {
	var body []byte
	content := ""
	if input != nil {
		var err error
		body, err = json.Marshal(input)
		if err != nil {
			return err
		}
		content = "application/json"
	}
	response, err := session.Request(ctx, method, path, content, body)
	if err != nil || output == nil {
		return err
	}
	return json.Unmarshal(response, output)
}
