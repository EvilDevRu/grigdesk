package cli

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"grigdesk.local/tools/utilities/internal/buildinfo"
	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/pipeline/internal/arbiter"
	"grigdesk.local/tools/utilities/pipeline/internal/control"
	"grigdesk.local/tools/utilities/pipeline/internal/wait"
)

//go:embed help.txt
var help string

const kind = "pipeline"
const maxInput = 256 * 1024

type Command struct {
	Version string
}

type Dependencies struct {
	Env     map[string]string
	Config  localapi.ConfigIO
	Request func(context.Context, localapi.Connection, localapi.RequestSpec) ([]byte, error)
	Clock   wait.Clock
}

// Run передаёт контекст процесса во все чтения и мутации API.
// Локальные флаги и валидация не обращаются к настройкам и серверу.
func (command Command) Run(
	ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer,
) int {
	return command.RunWithIO(ctx, args, stdin, stdout, stderr, Dependencies{
		Env:    localapi.ProcessEnv(),
		Config: localapi.ProcessConfigIO(),
		Request: func(
			ctx context.Context, connection localapi.Connection, spec localapi.RequestSpec,
		) ([]byte, error) {
			return localapi.Request(ctx, connection, spec, 0)
		},
	})
}

// RunWithIO использует тот же диспетчер с подставными часами и IO.
// Наблюдение или подтверждение записи выводится только после получения целого результата.
func (command Command) RunWithIO(
	ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer, dependencies Dependencies,
) int {
	if slices.Equal(args, []string{"--help"}) || slices.Equal(args, []string{"-h"}) {
		_, err := io.WriteString(stdout, help)
		return finish(ctx, stderr, err, false)
	}
	if slices.Equal(args, []string{"--license"}) {
		var license strings.Builder
		_, _ = buildinfo.Local(&license, args, kind, command.Version, true)
		license.WriteString(localapi.DependencyLicenses())
		_, err := io.WriteString(stdout, license.String())
		return finish(ctx, stderr, err, false)
	}
	if code, handled := buildinfo.Local(stdout, args, kind, command.Version, false); handled {
		return code
	}
	name := ""
	if len(args) != 0 {
		name = args[0]
	}
	spec, exists := commands[name]
	if !exists {
		return finish(ctx, stderr, control.Usage("Неизвестная команда pipeline. См. pipeline --help."), false)
	}
	code, err := execute(ctx, name, spec, args[1:], stdin, stdout, dependencies)
	if err != nil {
		return finish(ctx, stderr, err, spec.method == http.MethodPost)
	}
	if code == 3 {
		_, _ = fmt.Fprintln(stderr, "Решение или настройки сохранены; продолжение не состоялось. "+
			"Прочитайте состояние и повторите только продолжение.")
	}
	return code
}

// execute выбирает endpoint после проверки параметров и тела закрытым контрактом.
// Метод отправляется один раз, а wait использует отдельный контекст наблюдения.
func execute(
	ctx context.Context, name string, spec commandSpec, params []string,
	stdin io.Reader, stdout io.Writer, dependencies Dependencies,
) (int, error) {
	values, err := spec.arguments(params)
	if err != nil {
		return 0, err
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if name == "gate" && !strings.HasPrefix(values["key"], "GATE_") {
		return 0, control.Usage("Нужен точный ключ GATE_*.")
	}
	var body []byte
	if spec.method == http.MethodPost {
		body, err = postData(ctx, name, values, stdin)
		if err != nil {
			return 0, err
		}
	}

	connection, err := localapi.ResolveConnection(dependencies.Env, dependencies.Config)
	if err != nil {
		return 0, &control.Failure{Code: 1, Text: err.Error()}
	}
	client := pipelineClient{connection: connection, request: dependencies.Request, output: stdout}
	if name == "wait" {
		return client.wait(ctx, values, dependencies.Clock)
	}
	return client.invoke(ctx, name, values, spec, body)
}

// postData читает не более 256 КиБ и сохраняет проверенный DTO одной отправки.
// Ошибки IO, кодировки, формы или команды завершат вызов до сетевых эффектов.
func postData(
	ctx context.Context, command string, values map[string]string, input io.Reader,
) ([]byte, error) {
	data, err := readInput(ctx, input)
	if err != nil {
		return nil, &control.Failure{Code: 1, Text: "Не удалось прочитать stdin."}
	}
	if len(data) > maxInput {
		return nil, control.Usage("JSON из stdin превышает 256 КиБ.")
	}
	data = bytes.TrimPrefix(data, []byte("\ufeff"))
	var payload map[string]any
	if !utf8.Valid(data) || json.Unmarshal(data, &payload) != nil || payload == nil {
		return nil, control.Usage("Нужен JSON-объект UTF-8 из stdin, не больше 256 КиБ.")
	}
	if strings.HasPrefix(command, "arbiter-") {
		err = arbiter.Validate(command, values["task"], payload)
	} else {
		err = control.Validate(command, values, payload)
	}
	if err != nil {
		return nil, err
	}
	var result bytes.Buffer
	if err := json.Compact(&result, data); err != nil {
		return nil, err
	}
	return result.Bytes(), nil
}

// readInput прекращает ожидание незакрытого pipe при сигнале.
// Чтение ограничено размером DTO, а горутина после отмены принадлежит завершающемуся CLI.
func readInput(ctx context.Context, input io.Reader) ([]byte, error) {
	type result struct {
		data []byte
		err  error
	}
	ready := make(chan result, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(input, maxInput+1))
		ready <- result{data: data, err: err}
	}()
	select {
	case <-ctx.Done():
		return nil, context.Cause(ctx)
	case read := <-ready:
		return read.data, read.err
	}
}

type pipelineClient struct {
	connection localapi.Connection
	request    func(context.Context, localapi.Connection, localapi.RequestSpec) ([]byte, error)
	output     io.Writer
}

const stageRunnerSpeedAccept = "application/json; grigdesk-stage-speed=1"

// invoke обрабатывает один успешный ответ, включая форму частичного выполнения.
// Журнал арбитра передаётся байтами, остальным командам нужен валидный JSON.
func (client pipelineClient) invoke(
	ctx context.Context, name string, values map[string]string, spec commandSpec, body []byte,
) (int, error) {
	query := localapi.RequestSpec{
		Method: spec.method,
		Path:   spec.endpoint(values),
		Body:   body,
		JSON:   body != nil,
	}
	if name == "runner-options" || name == "runner-set" {
		query.Accept = stageRunnerSpeedAccept
	}
	raw, err := client.request(ctx, client.connection, query)
	if err != nil {
		return 0, err
	}
	if name == "arbiter-journal" {
		_, err := client.output.Write(raw)
		return 0, err
	}

	raw, decoded, err := decodeReply(raw)
	if err != nil {
		return 0, err
	}
	result, err := formatOutput(name, values, raw, decoded)
	if err != nil {
		return 0, err
	}
	if err := client.write(result); err != nil {
		return 0, err
	}
	if partial(name, decoded) {
		return 3, nil
	}
	return 0, nil
}

// wait передаёт wait.Run функцию чтения JSON вместо HTTP-реализации.
// Весь срок действует и на наблюдения, и на ожидание между ними.
func (client pipelineClient) wait(
	ctx context.Context, values map[string]string, clock wait.Clock,
) (int, error) {
	target := wait.Target{
		Task:     values["task"],
		Attempt:  values["attempt"],
		Timeout:  time.Duration(integer(values["timeoutMs"])) * time.Millisecond,
		Interval: time.Duration(integer(values["intervalMs"])) * time.Millisecond,
	}
	result, err := wait.Run(ctx, target, func(ctx context.Context, path string) (any, error) {
		raw, err := client.request(ctx, client.connection, localapi.RequestSpec{Method: http.MethodGet, Path: path})
		if err != nil {
			return nil, err
		}
		_, value, err := decodeReply(raw)
		return value, err
	}, clock)
	if err != nil {
		return 0, err
	}
	return result.Code, client.write(result.Output)
}

// decodeReply исключает неполный JSON и неверную кодировку до любых записей в stdout.
// BOM удаляется так же, как при чтении TextDecoder перед JSON.parse.
func decodeReply(raw []byte) ([]byte, any, error) {
	raw = bytes.TrimPrefix(raw, []byte("\ufeff"))
	var value any
	if !utf8.Valid(raw) || json.Unmarshal(raw, &value) != nil {
		return nil, nil, &control.Failure{Code: 22, Text: "GrigDesk вернул повреждённый JSON."}
	}
	return raw, value, nil
}

// write сериализует полный JSON-ответ перед выводом одной строки.
// Данные в stdout сохраняются, только если выполнился соответствующий запрос.
func (client pipelineClient) write(value any) error {
	encoded, err := jsonv2.Marshal(value, jsonv2.Deterministic(true))
	if err != nil {
		return err
	}
	_, err = client.output.Write(append(encoded, '\n'))
	return err
}

// finish сохраняет коды использования, транспорта и отмены.
// При неизвестном исходе записи подсказывает прочитать состояние перед повтором.
func finish(ctx context.Context, stderr io.Writer, err error, mutating bool) int {
	if err == nil || errors.Is(err, syscall.EPIPE) {
		return 0
	}
	code, message := 1, "Не удалось выполнить команду pipeline."
	var known *control.Failure
	var transport *localapi.HTTPError
	switch {
	case ctx.Err() != nil:
		code, message = 130, "Команда pipeline отменена."
	case errors.As(err, &known):
		code, message = known.Code, known.Text
	case errors.As(err, &transport):
		code, message = 22, transport.Text
	}
	if mutating && code == 22 {
		message += " Исход операции проверьте чтением состояния перед повтором."
	}
	_, _ = fmt.Fprintln(stderr, message)
	return code
}
