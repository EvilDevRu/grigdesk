package cli

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"syscall"

	"grigdesk.local/tools/utilities/internal/buildinfo"
	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/tracker/internal/task"
)

//go:embed help.txt
var help string

const kind = "tracker"

type Command struct {
	Version string
}

// Run связывает tracker с окружением процесса, его файлами и прямым HTTP.
// Разбор, чтение и отправка используют те же зависимости, что и изолированные проверки.
func (command Command) Run(
	ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer,
) int {
	return command.RunWithIO(ctx, args, stdin, stdout, stderr, Dependencies{
		Env:    localapi.ProcessEnv(),
		Config: localapi.ProcessConfigIO(),
		Request: func(ctx context.Context, connection task.Connection, spec task.RequestSpec) ([]byte, error) {
			return localapi.Request(ctx, connection, spec, 0)
		},
	})
}

// RunWithIO проверяет argv перед настройками, читает полный ответ и затем пишет его в stdout.
// Известное место отказа определяет код выхода. Необработанные ошибки остаются внутри процесса.
func (command Command) RunWithIO(
	ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer, dependencies Dependencies,
) int {
	if slices.Equal(args, []string{"--runtime-info", "--json"}) {
		code, _ := buildinfo.Local(stdout, args, kind, command.Version, false)
		return code
	}

	parsed, err := parseArgs(args)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "%s\n\n%s", err, help)
		return 2
	}

	switch parsed.Kind {
	case "--help", "-h":
		return writeAnswer(stdout, stderr, []byte(help))
	case "--license":
		var licenses strings.Builder
		_, _ = buildinfo.Local(&licenses, []string{"--license"}, kind, command.Version, true)
		licenses.WriteString(localapi.DependencyLicenses())
		return writeAnswer(stdout, stderr, []byte(licenses.String()))
	case "--version":
		var version strings.Builder
		_, _ = buildinfo.Local(&version, []string{"--version"}, kind, command.Version, false)
		return writeAnswer(stdout, stderr, []byte(version.String()))
	}

	connection, err := localapi.ResolveConnection(dependencies.Env, dependencies.Config)
	if err != nil {
		return fail(stderr, err.Error(), 1)
	}
	answer, err := task.Execute(ctx, parsed, connection, stdin, dependencies.Request)
	if err != nil {
		return executionFailure(stderr, err)
	}
	return writeAnswer(stdout, stderr, answer)
}

// executionFailure отображает только ошибки, для которых определён публичный результат.
// Содержание произвольных исключений транспорта и адаптеров остаётся скрытым.
func executionFailure(stderr io.Writer, err error) int {
	var commandFailure *task.CommandError
	if errors.As(err, &commandFailure) {
		return fail(stderr, commandFailure.Text, commandFailure.Code)
	}
	var httpFailure *task.HTTPError
	if errors.As(err, &httpFailure) {
		return fail(stderr, httpFailure.Text, 22)
	}
	return fail(stderr, "Не удалось выполнить команду tracker.", 1)
}

// writeAnswer выводит готовый ответ целиком. Закрытый pipe считается штатным исходом.
// Остальные ошибки записи возвращают отдельную диагностическую строку.
func writeAnswer(stdout, stderr io.Writer, answer []byte) int {
	written, err := stdout.Write(answer)
	if err == nil && written == len(answer) || errors.Is(err, syscall.EPIPE) {
		return 0
	}
	return fail(stderr, "Не удалось записать ответ.", 1)
}

func fail(stderr io.Writer, message string, code int) int {
	_, _ = fmt.Fprintln(stderr, message)
	return code
}
