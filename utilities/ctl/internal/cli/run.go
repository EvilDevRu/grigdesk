package cli

import (
	"context"
	_ "embed"
	"io"
	"os"
	"slices"

	"golang.org/x/term"

	"grigdesk.local/tools/utilities/ctl/internal/cleanup"
	"grigdesk.local/tools/utilities/ctl/internal/menu"
	"grigdesk.local/tools/utilities/ctl/internal/service"
	"grigdesk.local/tools/utilities/ctl/internal/source"
	"grigdesk.local/tools/utilities/internal/buildinfo"
	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/internal/installation"
)

//go:embed help.txt
var help string

const kind = "grigdesk-ctl"

type Command struct {
	Version string
}

// Run разбирает команду до эффектов и разрешает физический checkout.
func (command Command) Run(ctx context.Context, argv []string, stdin io.Reader, stdout, stderr io.Writer) int {
	terminal := service.Terminal{Stdin: stdin, Stdout: stdout, Stderr: stderr}
	env := localapi.ProcessEnv()
	if slices.Equal(argv, []string{"--runtime-info", "--json"}) {
		code, _ := buildinfo.Local(stdout, argv, kind, command.Version, false)
		return code
	}

	args, invalid := parse(argv)
	tty := isTTY(stdin) && isTTY(stdout)
	if args.kind == "help" || args.kind == "menu" && (!tty || service.InAgentScope(env)) {
		_, _ = io.WriteString(stdout, help)
		return 0
	}
	if args.kind == "artifacts-cleanup" {
		return cleanup.Run(ctx, env, args.tail, terminal, nil)
	}
	executable, problem := os.Executable()
	if problem != nil {
		return terminal.Fail("Не удалось найти файл grigdesk-ctl.", 1)
	}
	registeredRoot, installedError := installedCandidate(executable)
	if installedError != nil {
		return terminal.Fail(installedError.Error(), 1)
	}
	if registeredRoot != "" {
		if invalid != nil && !slices.Equal(argv, []string{"--version"}) && len(argv) > 0 && argv[0] != "routes" {
			return terminal.Fail(invalid.Error(), 2)
		}
		return registered(ctx, registeredRoot, argv, args, env, tty, terminal)
	}
	if root, found := installation.ServerDirectory(executable); found {
		if len(argv) > 0 && argv[0] == "run" {
			return runSea(ctx, root, argv[1:], env, terminal)
		}
		return packaged(ctx, root, command.Version, argv, args, invalid, env, tty, terminal)
	}
	if root, found := installation.Portable(executable); found {
		return packaged(ctx, root, command.Version, argv, args, invalid, env, tty, terminal)
	}
	root, rootError := source.Root(executable, env["GRIGDESK_CTL_CHECKOUT_ROOT"])
	if slices.Equal(argv, []string{"--version"}) {
		code, _ := buildinfo.Local(stdout, argv, kind, source.Version(root, command.Version), false)
		return code
	}
	if invalid != nil {
		return terminal.Fail(invalid.Error(), 2)
	}
	if args.guarded() && !args.force && service.InAgentScope(env) {
		return terminal.Fail("Команда прервёт ход агента или откроет окно из него. Используйте --force.", 1)
	}
	if rootError != nil {
		return terminal.Fail(rootError.Error(), 1)
	}
	if slices.Contains(delegated, args.kind) {
		err := source.Delegate(root, args.kind, args.tail)
		return terminal.Fail(err.Error(), 1)
	}
	settings, err := service.ReadSettings(root, env, false)
	if err != nil {
		return terminal.Fail(err.Error(), 1)
	}
	return dispatch(ctx, args, settings, tty, terminal)
}

func packaged(ctx context.Context, root, version string, argv []string, args arguments, invalid error,
	env map[string]string, tty bool, terminal service.Terminal) int {
	if slices.Equal(argv, []string{"--version"}) {
		code, _ := buildinfo.Local(terminal.Stdout, argv, kind, source.Version(root, version), false)
		return code
	}
	if invalid != nil {
		return terminal.Fail(invalid.Error(), 2)
	}
	if args.guarded() && !args.force && service.InAgentScope(env) {
		return terminal.Fail("Команда прервёт ход агента или откроет окно из него. Используйте --force.", 1)
	}
	return portable(ctx, root, args, env, tty, terminal)
}

func dispatch(ctx context.Context, args arguments, settings service.Settings, tty bool, terminal service.Terminal) int {
	if args.kind == "status" || args.action.Name == "status" {
		color := isTTY(terminal.Stdout) && settings.Env["NO_COLOR"] == "" && settings.Env["TERM"] != "dumb"
		return service.Status(ctx, settings, args.kind, args.json, color, terminal)
	}
	switch args.kind {
	case "open":
		window := service.OpenWindow(settings, terminal)
		if service.WindowStartsServer(settings) {
			return window
		}
		server := service.Server(ctx, settings, service.Action{Name: "start"}, terminal)
		if window != 0 {
			return window
		}
		return server
	case "server":
		switch args.action.Name {
		case "start", "stop", "restart", "logs":
			return service.Server(ctx, settings, args.action, terminal)
		}
	case "relay":
		return service.SetupRelay(ctx, settings, args.action.Name, args.tail, terminal)
	case "device":
		device, err := service.ParseDevice(args.tail)
		if err != nil {
			return terminal.Fail(err.Error(), 2)
		}
		return service.Device(ctx, settings, device, isTTY(terminal.Stdout) && settings.Env["NO_COLOR"] == "", terminal)
	case "build":
		target := ""
		if len(args.tail) != 0 {
			target = args.tail[0]
		}
		screen := tty && !service.InAgentScope(settings.Env) && settings.Env["GRIGDESK_CTL_BUILD_CHILD"] != "1"
		return source.Build(ctx, settings, target, screen, terminal)
	case "run", "dev", "deps":
		return source.Development(ctx, settings, args.kind, terminal)
	case "menu":
		return menu.Run(ctx, settings, terminal, func(argv []string) int {
			selected, err := parse(argv)
			if err != nil {
				return terminal.Fail(err.Error(), 2)
			}
			if selected.guarded() && !selected.force && service.InAgentScope(settings.Env) {
				return terminal.Fail("Команда прервёт ход агента или откроет окно из него. Используйте --force.", 1)
			}
			if selected.kind == "artifacts-cleanup" {
				return cleanup.Run(ctx, settings.Env, selected.tail, terminal, func(report cleanup.Report) bool {
					cleanup.ShowReport(report, terminal)
					return menu.ConfirmCleanup(ctx, settings, terminal)
				})
			}
			if slices.Contains(delegated, selected.kind) {
				return terminal.Fail(source.Delegate(settings.Root, selected.kind, selected.tail).Error(), 1)
			}
			return dispatch(ctx, selected, settings, true, terminal)
		})
	}
	return terminal.Fail("Команда grigdesk-ctl ещё не перенесена на Go.", 78)
}

func isTTY(stream any) bool {
	file, ok := stream.(*os.File)
	return ok && term.IsTerminal(int(file.Fd()))
}
