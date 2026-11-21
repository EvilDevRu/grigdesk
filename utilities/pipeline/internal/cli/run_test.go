package cli

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
)

type testInput struct {
	reads int
	err   error
}

func (input *testInput) Read([]byte) (int, error) {
	input.reads++
	return 0, input.err
}

// TestInvalidArgumentsAvoidIO подтверждает ранний отказ даже при недоступных зависимостях.
// Неизвестная команда и неправильный ID не читают stdin или конфигурацию.
func TestInvalidArgumentsAvoidIO(t *testing.T) {
	for _, args := range [][]string{
		{"state", "7x"}, {"state", "0007"}, {"state", "90071992547409931x"},
		{"raw", "/api/settings"}, {"gate", "7", "GATE_PLAN", "approve", "--yes"},
	} {
		stdin := &testInput{err: errors.New("нет stdin")}
		var stdout, stderr bytes.Buffer
		command := Command{Version: "0.2.0"}
		code := command.RunWithIO(t.Context(), args, stdin, &stdout, &stderr, Dependencies{})
		if code != 2 || stdin.reads != 0 || stdout.Len() != 0 {
			t.Errorf("%v: rc %d, stdin %d, stdout %q", args, code, stdin.reads, stdout.String())
		}
	}
}

// TestWritesOnlyValidPayload проводит в тестовый транспорт один завершённый JSON.
// Ошибка stdin и неверный DTO не начинают запрос, обрыв не вызывает повтор.
func TestWritesOnlyValidPayload(t *testing.T) {
	const valid = `{"operationId":"fixture"}`
	for _, test := range []struct {
		input string
		fault error
		code  int
		calls int
	}{
		{input: valid, code: 22, calls: 1},
		{input: `{"operationId":"fixture","foreign":true}`, code: 2},
		{input: "{" + strings.Repeat(" ", maxInput) + "}", code: 2},
		{fault: errors.New("EIO"), code: 1},
	} {
		var out, stderr bytes.Buffer
		var requests int
		dependencies := Dependencies{
			Env: map[string]string{"GRIGDESK_URL": "http://127.0.0.1:9", "GRIGDESK_TOKEN": "fixture"},
			Request: func(_ context.Context, _ localapi.Connection, req localapi.RequestSpec) ([]byte, error) {
				requests++
				if req.Method != "POST" || req.Path != "/api/tasks/7/arbiter-conversations/stop" ||
					string(req.Body) != valid || !req.JSON {
					t.Errorf("получен запрос %+v", req)
				}
				return nil, &localapi.HTTPError{Text: localapi.NetworkError}
			},
		}
		var stdin = strings.NewReader(test.input)
		command := Command{Version: "0.2.0"}
		var code int
		if test.fault != nil {
			code = command.RunWithIO(t.Context(), []string{"arbiter-stop", "7"}, &testInput{err: test.fault},
				&out, &stderr, dependencies)
		} else {
			code = command.RunWithIO(t.Context(), []string{"arbiter-stop", "7"}, stdin, &out, &stderr, dependencies)
		}
		if code != test.code || requests != test.calls || out.Len() != 0 {
			t.Errorf("rc %d, запросов %d, stdout %q", code, requests, out.String())
		}
	}
}
