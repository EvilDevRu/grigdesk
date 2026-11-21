package task

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// TestRequestSpec проверяет точные байты и адрес каждого простого действия.
// В адресной ветке меняется только префикс пути, включая имя доски с пробелом.
func TestRequestSpec(t *testing.T) {
	for _, test := range []struct {
		command Command
		method  string
		tail    string
		body    string
		isJSON  bool
	}{
		{Command{Kind: "dashboard"}, "GET", "/dashboard", "", false},
		{Command{Kind: "task", ID: "0042"}, "GET", "/task/0042", "", false},
		{Command{Kind: "task", ID: "a/b?c"}, "GET", "/task/a%2Fb%3Fc", "", false},
		{Command{Kind: "comment", ID: "42", Value: "текст \"с\" \\ кавычками\n"}, "POST", "/task/42/comment",
			`{"text":"текст \"с\" \\ кавычками\n"}`, true},
		{Command{Kind: "complete", ID: "42"}, "POST", "/task/42/complete", "", false},
		{Command{Kind: "renew", ID: "42"}, "POST", "/task/42/renew", "", false},
		{Command{Kind: "users"}, "GET", "/users?q=", "", false},
		{Command{Kind: "users", Value: "Иван П&+?"}, "GET",
			"/users?q=%D0%98%D0%B2%D0%B0%D0%BD+%D0%9F%26%2B%3F", "", false},
		{Command{Kind: "timer", ID: "42", Value: "start"}, "POST", "/task/42/timer/start", "", false},
		{Command{Kind: "timer", ID: "42", Value: "pause"}, "POST", "/task/42/timer/pause", "", false},
		{Command{Kind: "timer", ID: "42", Value: "stop"}, "POST", "/task/42/timer/stop", "", false},
		{Command{Kind: "create"}, "POST", "/tasks", "{not json\r\n", true},
	} {
		for _, target := range []struct{ board, prefix string }{
			{"", "/api/tracker"}, {"board/with space", "/api/tracker/board%2Fwith%20space"},
		} {
			command := test.command
			command.Board = target.board
			got, err := requestSpec(command, strings.NewReader(test.body))
			if err != nil || got.Method != test.method || got.Path != target.prefix+test.tail ||
				string(got.Body) != test.body || got.JSON != test.isJSON {
				t.Fatalf("%+v: получено %+v (%v)", command, got, err)
			}
		}
	}
}

// TestAddressedLaunch проверяет порядок context и POST, а также порядок полей запуска.
// Неуспешное подтверждение и конфликт source закрывают адресную ветку без второй цели.
func TestAddressedLaunch(t *testing.T) {
	const board = "fixture-a"
	source := board + "@" + strings.Repeat("a", 64)
	for _, test := range []struct {
		stdin, advertised string
		status            int
	}{
		{` {"profile":"demo","route":"feature","title":"Текст"}`, source, 0},
		{`{"source":null}`, source, 2},
		{`{"source":"other"}`, source, 2},
		{`{}`, "fixture-b@" + strings.Repeat("b", 64), 22},
		{`[]`, source, 2},
		{`{broken`, source, 2},
	} {
		var paths []string
		send := func(_ context.Context, _ Connection, spec RequestSpec) ([]byte, error) {
			paths = append(paths, spec.Path)
			if strings.HasSuffix(spec.Path, "/context") {
				return []byte(`{"source":"` + test.advertised + `"}`), nil
			}

			want := `{"profile":"demo","route":"feature","title":"Текст","source":"` + source + `"}`
			if spec.Method != "POST" || string(spec.Body) != want {
				t.Errorf("неверный запуск: %+v", spec)
			}
			return []byte("{\"outcome\":\"queued\"}\n"), nil
		}
		command := Command{Kind: "launch", ID: "42", Board: board}
		response, err := Execute(t.Context(), command, Connection{}, strings.NewReader(test.stdin), send)
		wantPaths := []string{"/api/tracker/fixture-a/context"}
		if test.status == 0 {
			wantPaths = append(wantPaths, "/api/tasks/42/launch")
			if err != nil || string(response) != "{\"outcome\":\"queued\"}\n" {
				t.Errorf("получено %q (%v)", response, err)
			}
		} else {
			var failure *CommandError
			if !errors.As(err, &failure) || failure.Code != test.status {
				t.Errorf("код %d: получено %v", test.status, err)
			}
			if test.stdin == `[]` || test.stdin == `{broken` {
				wantPaths = nil
			}
		}
		if !reflect.DeepEqual(paths, wantPaths) {
			t.Errorf("stdin %q: пути %v вместо %v", test.stdin, paths, wantPaths)
		}
	}
}
