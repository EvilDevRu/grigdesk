package source

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Root находит физический checkout от файла программы или заданного абсолютного пути.
// Текущий каталог и PATH не используются для поиска собственной копии.
func Root(executable, override string) (string, error) {
	candidate, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", err
	}
	directory := filepath.Dir(candidate)
	if filepath.Base(directory) == "utilities" && filepath.Base(filepath.Dir(directory)) == "bin" {
		directory = filepath.Dir(directory)
	}
	candidate = filepath.Dir(directory)
	if override != "" {
		if !filepath.IsAbs(override) {
			return "", errors.New("Путь checkout должен быть абсолютным")
		}
		candidate, err = filepath.EvalSymlinks(override)
		if err != nil {
			return "", errors.New("Не удалось открыть указанный checkout")
		}
	}
	for _, marker := range []string{"VERSION", "server/src/app.ts", "web/package.json", "desktop/package.json"} {
		info, err := os.Stat(filepath.Join(candidate, marker))
		if err != nil || !info.Mode().IsRegular() {
			return "", errors.New("Не удалось найти checkout GrigDesk")
		}
	}
	return candidate, nil
}

func Version(root, fallback string) string {
	if root == "" {
		return fallback
	}
	text, err := os.ReadFile(filepath.Join(root, "VERSION"))
	if err != nil || strings.TrimSpace(string(text)) == "" {
		return fallback
	}
	return strings.TrimSpace(string(text))
}
