package cli

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"

	"grigdesk.local/tools/utilities/internal/buildinfo"
)

//go:embed help.txt
var help string

const kind = "routes"

type Command struct {
	Version string
}

var commands = []string{
	"list", "show", "editor", "source", "new", "apply", "validate", "publish", "rollback",
	"publications", "export", "import", "profile-config",
}

// Run выбирает локальный результат либо один сценарий вызова API авторинга.
// Проверка аргументов происходит до чтения конфигурации и передачи токена.
func (command Command) Run(
	ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer,
) int {
	if code, handled := buildinfo.Local(stdout, args, kind, command.Version, true); handled {
		return code
	}
	if len(args) == 0 || args[0] == "" {
		_, _ = io.WriteString(stderr, help)
		return 1
	}
	if args[0] == "help" || args[0] == "--help" {
		_, _ = io.WriteString(stderr, help)
		return 0
	}

	if err := dispatch(ctx, args, stdout, stderr); err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		var failure *commandError
		if errors.As(err, &failure) {
			return failure.code
		}
		return 5
	}
	return 0
}

// dispatch берёт профиль из той позиции, которую задаёт форма конкретной команды.
// Профиль проходит проверку ещё до построения пути запроса.
func dispatch(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	operation := args[0]
	if !slices.Contains(commands, operation) {
		return usage("неизвестная команда: " + operation)
	}
	index := 1
	if operation == "profile-config" {
		index = 2
	}
	if len(args) <= index || !profilePattern.MatchString(args[index]) {
		return usage("нужен корректный профиль")
	}
	run := invocation{
		ctx:     ctx,
		profile: args[index],
		flags:   parseFlags(args[1:]),
		stdout:  stdout,
		stderr:  stderr,
	}
	return run.execute(operation, args[1:])
}

// execute направляет операцию в её собственный обработчик.
// Простые команды чтения используют только профиль и запрошенный ID.
func (run invocation) execute(operation string, args []string) error {
	switch operation {
	case "list":
		return run.show(http.MethodGet, run.base()+"/drafts", nil)
	case "editor":
		return run.show(http.MethodGet, run.base()+"/editor", nil)
	case "show":
		id, err := run.flags.showID()
		if err != nil {
			return err
		}
		return run.show(http.MethodGet, run.base()+"/drafts/"+id, nil)
	case "new":
		return run.newDraft()
	case "apply":
		return run.apply()
	case "source":
		return run.source()
	case "validate":
		return run.validate()
	case "export", "import":
		return run.transfer(operation)
	case "publish", "rollback":
		return run.publish(operation)
	case "publications":
		if len(args) < 2 || !operationPattern.MatchString(args[1]) {
			return usage("нужен корректный operationId")
		}
		return run.show(http.MethodGet, run.base()+"/publications/"+args[1], nil)
	case "profile-config":
		return run.profileConfig(args[0])
	default:
		return usage("неизвестная команда: " + operation)
	}
}
