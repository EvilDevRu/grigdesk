package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"

	"grigdesk.local/tools/utilities/maintenance/internal/install"
	"grigdesk.local/tools/utilities/maintenance/internal/update"

	"grigdesk.local/tools/utilities/internal/installation"
)

func openInstalled() (*installation.Layout, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if filepath.Base(exe) != "maintenance" || filepath.Base(filepath.Dir(exe)) != "update" {
		return nil, errors.New("maintenance_installation_required")
	}
	root := filepath.Dir(filepath.Dir(exe))
	layout, err := installation.Open(root)
	if err != nil {
		return nil, err
	}
	bound, err := layout.Maintenance()
	if err != nil {
		_ = layout.Close()
		return nil, err
	}
	_ = bound.Close()
	return layout, nil
}

func installed(ctx context.Context, args []string, stdout io.Writer) error {
	layout, err := openInstalled()
	if err != nil {
		return err
	}
	defer layout.Close()
	pointer, err := layout.Current()
	if err != nil {
		return err
	}
	if pointer.Format != 2 {
		return errors.New("release_go_migration_pending")
	}

	env := installedEnv(layout.Receipt)
	switch args[0] {
	case "ctl":
		return execInstalled(layout, *pointer.Control, "control", "bin/grigdesk-ctl", args[1:], env)
	case "launch":
		return launch(ctx, layout, pointer, args[1:], env)
	case "ctl-runtime":
		return runInstalledControl(ctx, layout, pointer, args[1:], env, stdout)
	}
	return errors.New("maintenance_action_invalid")
}

func installedEnv(receipt installation.Receipt) map[string]string {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = value
		}
	}
	return receipt.Environment(env)
}

func runInstalledControl(ctx context.Context, layout *installation.Layout, pointer installation.Pointer,
	args []string, env map[string]string, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New("maintenance_action_invalid")
	}
	switch args[0] {
	case "open":
		return launch(ctx, layout, pointer, []string{"desktop"}, env)
	case "recover-update":
		if len(args) < 3 || args[1] != "--job" {
			return update.InvalidRequest()
		}
		return printUpdate(ctx, layout, "recover", map[string]any{"schema": 1, "jobId": args[2]}, stdout)
	case "server":
		if len(args) < 2 {
			return update.InvalidRequest()
		}
		switch args[1] {
		case "start":
			return update.StartServer(ctx, layout, pointer, len(args) == 3 && args[2] == "--wait")
		case "stop":
			return update.StopServer(ctx, layout, pointer)
		case "restart":
			if err := update.StopServer(ctx, layout, pointer); err != nil {
				return err
			}
			return update.StartServer(ctx, layout, pointer, slices.Contains(args[2:], "--wait"))
		case "status":
			status, err := update.ServerStatus(ctx, layout, pointer)
			if err != nil {
				return err
			}
			return json.NewEncoder(stdout).Encode(status)
		case "logs":
			lines, follow, err := logOptions(args[2:])
			if err != nil {
				return err
			}
			return update.ServerLogs(ctx, layout, pointer, lines, follow, stdout)
		case "check-updates":
			return printUpdate(ctx, layout, "check", map[string]any{"schema": 1}, stdout)
		case "update-status":
			return printUpdate(ctx, layout, "status", map[string]any{"schema": 1}, stdout)
		case "update-channel":
			if len(args) == 3 {
				return printUpdate(ctx, layout, "set-channel", map[string]any{"schema": 1, "channel": args[2]}, stdout)
			}
		case "update", "resume-update":
			return serverUpdate(ctx, layout, args[1] == "resume-update", args[2:], stdout)
		}
	case "status":
		if len(args) == 2 && args[1] == "--json" {
			return json.NewEncoder(stdout).Encode(map[string]any{
				"mode": layout.Receipt.Mode, "version": pointer.Version(),
				"installationId": layout.Receipt.InstallationID, "current": pointer,
			})
		}
		if len(args) == 1 {
			_, err := fmt.Fprintf(stdout, "GrigDesk %s (%s)\n%s\n", pointer.Version(),
				layout.Receipt.Mode, layout.Receipt.Root)
			return err
		}
	}
	return errors.New("maintenance_action_invalid")
}

func launch(ctx context.Context, layout *installation.Layout, pointer installation.Pointer,
	args []string, env map[string]string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if len(args) == 0 {
		return errors.New("maintenance_action_invalid")
	}
	cgroup, _ := os.ReadFile("/proc/self/cgroup")
	if args[0] != "server" || !strings.Contains(string(cgroup), "/grigdesk-server.service") {
		for _, key := range []string{"INVOCATION_ID", "NOTIFY_SOCKET", "JOURNAL_STREAM"} {
			delete(env, key)
		}
	}
	switch args[0] {
	case "server":
		if pointer.Server != nil {
			commandPath := filepath.Join(layout.Receipt.Root, *pointer.Server, "bin")
			env["PATH"] = commandPath + ":" + env["PATH"]
			delete(env, "GRIGDESK_DESKTOP_CHILD")
			delete(env, "GRIGDESK_DESKTOP_PARENT")
			if err := update.RegisterServerLaunch(layout, filepath.Join(commandPath, "grigdesk-server")); err != nil {
				return err
			}
			return execInstalled(layout, *pointer.Server, "server", "bin/grigdesk-server", args[1:], env)
		}
	case "desktop":
		if pointer.Desktop != nil {
			if runtime.GOOS == "darwin" {
				executable, err := install.MacDesktopExecutable(ctx, layout, *pointer.Desktop)
				if err != nil {
					return err
				}
				return syscall.Exec(executable, append([]string{executable}, args[1:]...), installation.Environ(env))
			}
			return execInstalled(layout, *pointer.Desktop, "desktop", "GrigDesk", args[1:], env)
		}
	}
	return errors.New("installation_component_missing")
}

func execInstalled(layout *installation.Layout, selected, part, entry string, args []string,
	env map[string]string) error {
	exe, err := layout.Executable(selected, part, entry)
	if err != nil {
		return err
	}
	defer exe.Close()
	return exe.Exec(args, installation.Environ(env))
}

func printUpdate(ctx context.Context, layout *installation.Layout, action string,
	input map[string]any, stdout io.Writer) error {
	content, err := json.Marshal(input)
	if err != nil {
		return err
	}
	result, err := (update.Service{Layout: layout}).Action(ctx, action, content)
	if err != nil {
		return err
	}
	return json.NewEncoder(stdout).Encode(result)
}

func control(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) != 3 || args[2] != "--json" {
		return controlError(stderr, update.InvalidRequest())
	}
	const limit = 64 << 10
	body, err := io.ReadAll(io.LimitReader(stdin, limit+1))
	if err != nil || len(body) > limit {
		return controlError(stderr, update.InvalidRequest())
	}
	layout, err := openInstalled()
	if err != nil {
		return controlError(stderr, err)
	}
	defer layout.Close()
	cwd, err := os.Getwd()
	if err != nil || cwd != layout.Receipt.Root {
		return controlError(stderr, errors.New("maintenance_installation_required"))
	}
	result, err := (update.Service{Layout: layout}).Action(ctx, args[1], body)
	if err == nil {
		err = json.NewEncoder(stdout).Encode(result)
	}
	if err != nil {
		return controlError(stderr, err)
	}
	return 0
}

func controlError(stderr io.Writer, err error) int {
	_ = json.NewEncoder(stderr).Encode(map[string]string{"code": err.Error(), "message": err.Error()})
	if err.Error() == "maintenance_request_invalid" {
		return 2
	}
	return 1
}
