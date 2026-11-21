package service

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
)

type Settings struct {
	Root       string
	DataHome   string
	Home       string
	Origin     string
	Port       string
	EnvFile    string
	TokenPath  string
	WindowKey  string
	Portable   bool
	Env        map[string]string
	ServerWork string
	Registered string
	Version    string
}

var dataHomeAlphabet = regexp.MustCompile(`^/[A-Za-z0-9._+/@,=:\-]+$`)

// DataDirectory вычисляет путь данных по общему контракту Node, shell и systemd.
// Сегменты пути проверяются до чтения файлов в нём.
func DataDirectory(env map[string]string) (string, error) {
	home := env["HOME"]
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	directory := env["GRIGDESK_HOME"]
	if directory == "" {
		directory = strings.TrimRight(home, "/") + "/.grigdesk"
	}
	directory = strings.TrimRight(directory, "/")
	if !dataHomeAlphabet.MatchString(directory) {
		return "", fmt.Errorf("GRIGDESK_HOME должен быть абсолютным путём — получено: %s", Printable(directory))
	}
	for _, part := range strings.Split(directory, "/") {
		if part == "." || part == ".." {
			return "", errors.New("Каталог данных не должен содержать сегменты . и ..")
		}
	}
	return directory, nil
}

// ReadSettings читает настройки в контексте выбранной копии, сохраняя явные пустые значения env.
func ReadSettings(root string, env map[string]string, portable bool) (Settings, error) {
	data, err := DataDirectory(env)
	if err != nil {
		return Settings{}, err
	}
	file := env["GRIGDESK_ENV_FILE"]
	if file == "" {
		file = filepath.Join(data, ".env")
		if missing(file) && regular(filepath.Join(root, ".env")) {
			file = filepath.Join(root, ".env")
		}
	}
	text, err := os.ReadFile(file)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Settings{}, err
	}
	dotenv := localapi.ParseDotenv(string(text))
	for _, key := range []string{"GRIGDESK_HOME", "GRIGDESK_ENV_FILE"} {
		if _, exists := dotenv[key]; exists {
			return Settings{}, fmt.Errorf("Ключ %s запрещён в файле настроек.", key)
		}
	}
	value := func(key string) string {
		if parsed, exists := env[key]; exists {
			return parsed
		}
		return dotenv[key]
	}
	port := value("GRIGDESK_PORT")
	if parsed, _ := strconv.ParseFloat(strings.TrimSpace(port), 64); parsed == 0 {
		port = "8140"
	} else {
		port = strconv.FormatFloat(parsed, 'f', -1, 64)
	}
	token := value("GRIGDESK_CLI_TOKEN_PATH")
	if token == "" {
		token = filepath.Join(data, "state", "cli-token")
		legacy := filepath.Join(root, "server", ".state")
		if info, err := os.Lstat(legacy); missing(token) && err == nil && info.IsDir() {
			token = filepath.Join(legacy, "cli-token")
		}
	}
	home := env["HOME"]
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return Settings{
		Root: root, DataHome: data, Home: home, Origin: "http://127.0.0.1:" + port, Port: port, EnvFile: file,
		TokenPath: token, WindowKey: value("GRIGDESK_WINDOW_KEY_PATH"),
		Env: env, Portable: portable, ServerWork: filepath.Join(root, "server"),
	}, nil
}

func missing(file string) bool {
	_, err := os.Lstat(file)
	return errors.Is(err, os.ErrNotExist)
}

func regular(file string) bool {
	info, err := os.Lstat(file)
	return err == nil && info.Mode().IsRegular()
}
