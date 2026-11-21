package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"syscall"
	"testing"

	"grigdesk.local/tools/utilities/tracker/internal/task"
)

type failureIO struct {
	err   error
	calls int
}

func (failure *failureIO) Read([]byte) (int, error) {
	failure.calls++
	return 0, failure.err
}

func (failure *failureIO) Write([]byte) (int, error) {
	failure.calls++
	return 0, failure.err
}

var testTracker = Command{Version: "0.2.0"}

func envConnection() map[string]string {
	return map[string]string{"GRIGDESK_URL": "http://127.0.0.1:9", "GRIGDESK_TOKEN": "tok"}
}

// TestTrackerLocal проверяет обработку аргументов до любых обращений к настройкам.
// Недоступная зависимость выявит случайное чтение во время справки или ошибки.
func TestTrackerLocal(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"--version"}, {"--license"}} {
		var out, stderr bytes.Buffer
		code := testTracker.RunWithIO(t.Context(), args, nil, &out, &stderr, Dependencies{})
		if code != 0 || out.Len() == 0 || stderr.Len() != 0 {
			t.Fatalf("аргументы %v: статус %d, stdout %q, stderr %q", args, code, out.String(), stderr.String())
		}
	}
	for _, args := range [][]string{nil, {"frobnicate"}, {"task"}, {"dashboard", "extra"}, {"--help", "extra"}} {
		var out, stderr bytes.Buffer
		code := testTracker.RunWithIO(t.Context(), args, nil, &out, &stderr, Dependencies{})
		if code != 2 || out.Len() != 0 || !strings.HasSuffix(stderr.String(), help) {
			t.Errorf("аргументы %v: статус %d, stdout %q, stderr %q", args, code, out.String(), stderr.String())
		}
	}
}

// TestTrackerInputFailure проверяет код и порядок отказа конфигурации или stdin.
// Ни одна из этих ошибок не должна открыть HTTP или вывести частичный ответ.
func TestTrackerInputFailure(t *testing.T) {
	for _, test := range []struct {
		args []string
		env  map[string]string
		want string
		read int
	}{
		{[]string{"dashboard"}, nil, "Нет токена: /home/user/.grigdesk/state/cli-token.\n", 0},
		{[]string{"create"}, envConnection(), "Не удалось прочитать JSON из stdin.\n", 1},
		{[]string{"dashboard"}, map[string]string{"GRIGDESK_URL": "ftp://host", "GRIGDESK_TOKEN": "tok"},
			"Некорректный адрес GrigDesk: нужен HTTP(S) URL без учётных данных и query.\n", 0},
	} {
		stdin := &failureIO{err: errors.New("EIO")}
		var out, stderr bytes.Buffer
		dependencies := Dependencies{
			Env: test.env,
			Config: task.ConfigIO{
				GetHome:  func() string { return "/home/user" },
				ReadText: func(string) (string, error) { return "", fs.ErrNotExist },
			},
		}
		code := testTracker.RunWithIO(t.Context(), test.args, stdin, &out, &stderr, dependencies)
		if code != 1 || out.Len() != 0 || stderr.String() != test.want || stdin.calls != test.read {
			t.Errorf("%v: код %d, stdout %q, stderr %q, stdin %d", test.args, code, out.String(),
				stderr.String(), stdin.calls)
		}
	}
}

// TestTrackerWriteFailure проверяет EPIPE и ошибки остальных потоков.
// Внутреннее исключение не выводится, даже если stderr доступен.
func TestTrackerWriteFailure(t *testing.T) {
	for _, test := range []struct {
		write, request error
		wantCode       int
		wantError      string
		brokenStderr   bool
	}{
		{write: syscall.EPIPE},
		{write: syscall.EIO, wantCode: 1, wantError: "Не удалось записать ответ.\n"},
		{request: errors.New("internal stack"), wantCode: 1, wantError: "Не удалось выполнить команду tracker.\n"},
		{request: errors.New("internal stack"), wantCode: 1, brokenStderr: true},
	} {
		var diagnostic bytes.Buffer
		var stderr io.Writer = &diagnostic
		if test.brokenStderr {
			stderr = &failureIO{err: syscall.EIO}
		}
		dependencies := Dependencies{
			Env: envConnection(),
			Request: func(context.Context, task.Connection, task.RequestSpec) ([]byte, error) {
				return []byte("{}"), test.request
			},
		}
		code := testTracker.RunWithIO(t.Context(), []string{"dashboard"}, nil, &failureIO{err: test.write},
			stderr, dependencies)
		if code != test.wantCode || diagnostic.String() != test.wantError {
			t.Errorf("ошибка %v: код %d, stderr %q", test.write, code, diagnostic.String())
		}
	}
}

// TestTrackerRawCreate проверяет точный stdin, включая данные, которые парсит только сервер.
// Транспорт получает ровно один POST и возвращает байты ответа без преобразований.
func TestTrackerRawCreate(t *testing.T) {
	for _, payload := range []string{" {\"title\":\"т\"}\n", "{\"title\":\"т\"}\r\n", "", "{not json"} {
		var out, stderr bytes.Buffer
		var calls int
		dependencies := Dependencies{
			Env: envConnection(),
			Request: func(_ context.Context, connection task.Connection, spec task.RequestSpec) ([]byte, error) {
				calls++
				if spec.Method != http.MethodPost || spec.Path != "/api/tracker/tasks" ||
					!spec.JSON || string(spec.Body) != payload || connection.Token != "tok" {
					t.Errorf("получен запрос %+v", spec)
				}
				return []byte("{\"id\":1}\n"), nil
			},
		}
		code := testTracker.RunWithIO(t.Context(), []string{"create"}, strings.NewReader(payload),
			&out, &stderr, dependencies)
		if code != 0 || calls != 1 || out.String() != "{\"id\":1}\n" || stderr.Len() != 0 {
			t.Errorf("код %d, запросов %d, stdout %q, stderr %q", code, calls, out.String(), stderr.String())
		}
	}
}
