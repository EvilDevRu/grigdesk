package source

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
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
