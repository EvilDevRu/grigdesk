package hooks

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

// profileShell требует физический путь к Bash Windows.
// Он может быть из Git for Windows и не должен вести к загрузчику системного каталога.
func profileShell() (string, error) {
	candidate := os.Getenv("FACTORY_WINDOWS_BASH")
	if candidate == "" {
		candidate = filepath.Join(os.Getenv("ProgramFiles"), "Git", "bin", "bash.exe")
	}
	if !validCheckoutPath(candidate) || !strings.EqualFold(filepath.Base(candidate), "bash.exe") {
		return "", fmt.Errorf("Windows: укажите абсолютный FACTORY_WINDOWS_BASH")
	}
	if root := os.Getenv("SystemRoot"); root != "" && checkoutOverlap(root, candidate) {
		return "", fmt.Errorf("Windows: системный загрузчик Bash не поддерживается")
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil || resolved != candidate {
		return "", fmt.Errorf("Windows: Bash профиля должен быть физическим файлом")
	}
	info, err := os.Stat(candidate)
	if err != nil || !host.Executable(candidate, info) {
		return "", fmt.Errorf("Windows: Bash профиля недоступен")
	}

	return candidate, nil
}

func validCheckoutPath(item string) bool {
	volume := filepath.VolumeName(item)
	return len(volume) == 2 && volume[1] == ':' && len(item) > 3 &&
		filepath.IsAbs(item) && filepath.Clean(item) == item && !strings.ContainsAny(item[2:], ":\t\r\n\"")
}
