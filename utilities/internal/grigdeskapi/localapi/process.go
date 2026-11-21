package localapi

import (
	_ "embed"
	"os"
	"os/user"
	"strings"
)

//go:embed third-party-licenses.txt
var dependencyLicenses string

func DependencyLicenses() string {
	return dependencyLicenses
}

// ProcessEnv снимает копию окружения, сохраняя отдельно отсутствующие и пустые значения.
// Файловые настройки загружаются только по явному вызову читателя.
func ProcessEnv() map[string]string {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		env[key] = value
	}
	return env
}

// ProcessConfigIO определяет источники данных для CLI без чтения файлов при создании.
// Домашняя папка берётся у текущего пользователя, когда HOME отсутствует.
func ProcessConfigIO() ConfigIO {
	return ConfigIO{
		GetHome: func() string {
			if home, err := os.UserHomeDir(); err == nil {
				return home
			}
			if current, err := user.Current(); err == nil {
				return current.HomeDir
			}
			return ""
		},
		ReadText: func(path string) (string, error) {
			contents, err := os.ReadFile(path)
			return strings.ToValidUTF8(string(contents), "�"), err
		},
	}
}
