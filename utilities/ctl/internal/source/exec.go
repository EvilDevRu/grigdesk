package source

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"

	"grigdesk.local/tools/utilities/ctl/internal/service"
)

// Exec передаёт исходные argv и потоки одной заранее выбранной команде.
func Exec(root, name string, args []string) error {
	if !filepath.IsAbs(name) {
		var err error
		name, err = exec.LookPath(name)
		if err != nil {
			return err
		}
	}
	if err := os.Chdir(root); err != nil {
		return err
	}
	return syscall.Exec(name, append([]string{name}, args...), os.Environ())
}

// Delegate выбирает только фиксированные соседние исполняемые файлы или инструменты checkout.
func Delegate(root, name string, args []string) error {
	switch name {
	case "tracker", "pipeline", "voice":
		file := filepath.Join(root, "bin", "utilities", name)
		if info, err := os.Stat(file); err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			return fmt.Errorf("Установите отдельный исполняемый файл %s в bin/utilities этой копии", name)
		}
		return Exec(root, file, args)
	case "desktop":
		return Exec(root, filepath.Join(root, "deploy", "desktop.sh"), args)
	case "mobile", "release":
		return Exec(root, filepath.Join(root, "tools", name), args)
	case "dist":
		return Exec(root, "node", append([]string{filepath.Join(root, "tools", "distribution.mts")}, args...))
	default:
		return errors.New("Неизвестная команда")
	}
}

// Distribution запускает инструмент дистрибутива внутри сеанса меню.
// Строки прогресса и итог читаются родительским процессом на том же экране.
func Distribution(ctx context.Context, settings service.Settings, args []string, terminal service.Terminal) int {
	runner := &builder{settings: settings, term: terminal}
	argv := append([]string{filepath.Join(settings.Root, "tools", "distribution.mts")}, args...)
	child := runner.execute(ctx, settings.Root, "node", argv...)
	child.Stdout, child.Stderr = terminal.Stdout, terminal.Stderr
	child.Stdin = terminal.Stdin
	if len(args) > 0 && args[0] == "build" {
		child.Env = append(child.Env, "GRIGDESK_CTL_DIST_PROGRESS=1")
		if runtime.GOOS == "darwin" {
			// Инструмент дожидается уборки собственной установки по этому сигналу.
			child.Cancel = func() error { return child.Process.Signal(syscall.SIGTERM) }
			child.WaitDelay = 0
		}
	}

	err := child.Run()
	if ctx.Err() != nil {
		return 130
	}
	var status *exec.ExitError
	if err != nil && !errors.As(err, &status) {
		return terminal.Fail(err.Error(), 1)
	}
	return service.ExitCode(err)
}
