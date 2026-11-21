package cli

import (
	"context"
	"errors"
	"io"
	"slices"

	"grigdesk.local/tools/utilities/ctl/internal/menu"
	"grigdesk.local/tools/utilities/ctl/internal/service"
	"grigdesk.local/tools/utilities/internal/buildinfo"
	"grigdesk.local/tools/utilities/internal/installation"
)

var updateActions = []string{"check-updates", "update-status", "update", "resume-update", "update-channel"}

func registered(ctx context.Context, root string, argv []string, args arguments, env map[string]string,
	tty bool, terminal service.Terminal) int {
	group := ""
	if len(argv) > 0 {
		group = argv[0]
	}
	if slices.Contains([]string{"tracker", "routes", "voice", "desktop", "dev", "deps", "run", "build",
		"dist", "mobile", "release"}, group) {
		if slices.Contains(argv, "--help") || slices.Contains(argv, "-h") {
			_, _ = io.WriteString(terminal.Stdout, help)
			return 0
		}
		return terminal.Fail("Команда "+group+" доступна в установке из исходников. "+hint, 2)
	}
	layout, err := installation.Open(root)
	if err != nil {
		return terminal.Fail(err.Error(), 1)
	}
	defer layout.Close()
	return registeredAction(ctx, layout, argv, args, env, tty, terminal)
}

func registeredAction(ctx context.Context, layout *installation.Layout, argv []string, args arguments,
	env map[string]string, tty bool, terminal service.Terminal) int {
	receipt := layout.Receipt
	clean := receipt.Environment(env)
	pointer, err := layout.Current()
	if err != nil {
		return terminal.Fail(err.Error(), 1)
	}
	if pointer.Desktop != nil {
		if _, err := layout.Manifest(*pointer.Desktop, "desktop"); err != nil {
			return terminal.Fail(err.Error(), 1)
		}
	}
	if pointer.Server != nil && args.kind != "pipeline" {
		if _, err := layout.Manifest(*pointer.Server, "server"); err != nil {
			return terminal.Fail(err.Error(), 1)
		}
	}
	if slices.Equal(argv, []string{"--version"}) {
		code, _ := buildinfo.Local(terminal.Stdout, argv, kind, pointer.Version(), false)
		return code
	}
	if args.kind == "pipeline" {
		if pointer.Server == nil {
			return terminal.Fail("В этой установке нет сервера для pipeline.", 1)
		}
		binary, err := layout.Executable(*pointer.Server, "server", "bin/pipeline")
		if err != nil {
			return terminal.Fail("Не удалось проверить запускаемый pipeline: "+err.Error(), 1)
		}
		defer binary.Close()
		return terminal.Fail(binary.Exec(args.tail, installation.Environ(clean)).Error(), 1)
	}
	mutatingUpdate := args.kind == "server" && (slices.Contains(args.tail, "--restart") ||
		slices.Contains(args.tail, "--rollback"))
	force := args.force || mutatingUpdate && slices.Contains(args.tail, "--force")
	if (args.guarded() || mutatingUpdate) && !force && service.InAgentScope(clean) {
		return terminal.Fail("Команда прервёт ход агента или откроет окно из него. Используйте --force.", 1)
	}
	if args.kind == "relay" {
		if pointer.Server == nil {
			return terminal.Fail("Мастер требует локальный домашний сервер.", 1)
		}
		settings, err := service.ReadSettings(receipt.Root, clean, false)
		if err != nil {
			return terminal.Fail(err.Error(), 1)
		}
		if args.action.Name == "status" {
			return dispatch(ctx, args, settings, tty, terminal)
		}
		return service.SetupRelay(ctx, settings, args.action.Name, args.tail, terminal)
	}
	if args.kind == "device" {
		if pointer.Server == nil {
			return terminal.Fail("Управление устройствами требует локальный домашний сервер.", 1)
		}
		settings, err := service.ReadSettings(receipt.Root, clean, false)
		if err != nil {
			return terminal.Fail(err.Error(), 1)
		}
		return dispatch(ctx, args, settings, tty, terminal)
	}
	if args.kind == "menu" {
		settings, err := service.ReadSettings(receipt.Root, clean, false)
		if err != nil {
			return terminal.Fail(err.Error(), 1)
		}
		settings.ServerWork = receipt.Root
		settings.Registered = receipt.Mode
		settings.Version = pointer.Version()
		return menu.Run(ctx, settings, terminal, func(next []string) int {
			parsed, invalid := parse(next)
			if invalid != nil {
				return terminal.Fail(invalid.Error(), 2)
			}
			return registered(ctx, receipt.Root, next, parsed, clean, true, terminal)
		})
	}
	if args.kind == "open" && pointer.Desktop == nil {
		return terminal.Fail("В этой установке нет окна GrigDesk.", 1)
	}
	if args.kind == "server" && pointer.Server == nil &&
		!slices.Contains(updateActions, args.action.Name) {
		return terminal.Fail("Операция недоступна в этом режиме установки.", 1)
	}
	if slices.Contains([]string{"server", "status", "open", "recover-update"}, args.kind) {
		if pointer.Format != 2 {
			return terminal.Fail("Для управления этой установкой завершите переход на Go.", 1)
		}
		binary, err := layout.Maintenance()
		if err != nil {
			return terminal.Fail(err.Error(), 1)
		}
		defer binary.Close()
		return terminal.Fail(binary.Exec(append([]string{"ctl-runtime"}, argv...), installation.Environ(clean)).Error(), 1)
	}
	return terminal.Fail("Операция недоступна в этом режиме установки.", 2)
}

func portable(ctx context.Context, root string, args arguments, env map[string]string,
	tty bool, terminal service.Terminal) int {
	if slices.Contains([]string{"tracker", "voice", "pipeline"}, args.kind) {
		binary, err := installation.PortableExecutable(root, args.kind)
		if err != nil {
			return terminal.Fail(err.Error(), 1)
		}
		defer binary.Close()
		return terminal.Fail(binary.Exec(args.tail, installation.Environ(env)).Error(), 1)
	}
	if slices.Contains(delegated, args.kind) || args.kind == "run" || args.kind == "dev" || args.kind == "deps" ||
		args.kind == "build" || args.kind == "server" && slices.Contains(updateActions, args.action.Name) {
		return terminal.Fail("Операция недоступна в переносимой установке.", 2)
	}
	settings, err := service.ReadSettings(root, env, true)
	if err != nil {
		return terminal.Fail(err.Error(), 1)
	}
	return dispatch(ctx, args, settings, tty, terminal)
}

func installedCandidate(executable string) (string, error) {
	root, err := installation.Candidate(executable)
	if err != nil {
		return "", errors.New("Не удалось проверить физический путь установки.")
	}
	return root, nil
}
