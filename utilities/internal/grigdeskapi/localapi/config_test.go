package localapi

import (
	"errors"
	"io/fs"
	"maps"
	"slices"
	"strings"
	"testing"
)

const fixtureHome = "/home/user"
const fixtureEnv = fixtureHome + "/.grigdesk/.env"
const fixtureToken = fixtureHome + "/.grigdesk/state/cli-token"

// TestConfigFastPath проверяет явный URL и токен отдельно от настроек на диске.
// Даже недопустимая папка или отсутствующий файл на эту ветку не влияют.
func TestConfigFastPath(t *testing.T) {
	for _, test := range []struct {
		input string
		want  string
	}{
		{"http://127.0.0.1:9/", "http://127.0.0.1:9"},
		{"https://example.test/base/", "https://example.test/base"},
		{"http://127.0.0.1:8140/base//", "http://127.0.0.1:8140/base"},
	} {
		connection, err := ResolveConnection(map[string]string{
			"GRIGDESK_URL":      test.input,
			"GRIGDESK_TOKEN":    " secret ",
			"GRIGDESK_HOME":     "relative bad",
			"GRIGDESK_ENV_FILE": "/missing/.env",
			"HOME":              "bad",
		}, ConfigIO{})
		if err != nil || connection != (Connection{test.want, " secret "}) {
			t.Fatalf("для %s получено %+v, ошибка %v", test.input, connection, err)
		}
	}
}

type configFixture struct {
	files map[string]string
	fault map[string]error
	reads []string
	homes int
}

// io предоставляет настройки только через словарь фикстуры.
// Все обращения записываются для проверки порядка и отсутствия запасного чтения.
func (f *configFixture) io() ConfigIO {
	return ConfigIO{
		GetHome: func() string {
			f.homes++
			return fixtureHome
		},
		ReadText: func(file string) (string, error) {
			f.reads = append(f.reads, file)
			if err := f.fault[file]; err != nil {
				return "", err
			}
			if text, ok := f.files[file]; ok {
				return text, nil
			}
			return "", fs.ErrNotExist
		},
	}
}

// TestConfigFilePriority проверяет порядок экспортированных значений и файла.
// Пути с пробелами, кавычками и shell-выражениями читаются буквально.
func TestConfigFilePriority(t *testing.T) {
	const alternateEnv = "/etc/grigdesk.env"
	const fileToken = "/run/с пробелом/token"
	const literalTokenPath = "/tok/$(touch /tmp/tracker-pwned)"
	for _, test := range []struct {
		name      string
		env       map[string]string
		files     map[string]string
		reads     []string
		want      Connection
		wantHomes int
	}{
		{
			name: "умолчание", env: map[string]string{"HOME": fixtureHome},
			files: map[string]string{fixtureToken: "\r\n tok-home \r\n"},
			reads: []string{fixtureEnv, fixtureToken}, want: Connection{"http://localhost:8140", "tok-home"},
		},
		{
			name: "папка данных", env: map[string]string{"GRIGDESK_HOME": "/data/c//"},
			files: map[string]string{"/data/c/state/cli-token": "tok-data"},
			reads: []string{"/data/c/.env", "/data/c/state/cli-token"},
			want:  Connection{"http://localhost:8140", "tok-data"}, wantHomes: 1,
		},
		{
			name: "файл", env: map[string]string{"HOME": fixtureHome, "GRIGDESK_ENV_FILE": alternateEnv},
			files: map[string]string{
				alternateEnv: "export GRIGDESK_PORT = '18140' # порт\r\n" +
					"GRIGDESK_CLI_TOKEN_PATH=\"" + fileToken + "\"\n" +
					"GRIGDESK_URL=http://example.test\nGRIGDESK_TOKEN=ignored\n",
				fileToken: "  tok-file  \n",
			},
			reads: []string{alternateEnv, fileToken}, want: Connection{"http://localhost:18140", "tok-file"},
		},
		{
			name: "экспорт", env: map[string]string{
				"HOME": fixtureHome, "GRIGDESK_ENV_FILE": alternateEnv,
				"GRIGDESK_PORT": "28140", "GRIGDESK_CLI_TOKEN_PATH": "/env-token",
			},
			files: map[string]string{alternateEnv: "GRIGDESK_PORT=18140\nGRIGDESK_CLI_TOKEN_PATH=/ignored\n",
				"/env-token": "tok-env-path"},
			reads: []string{alternateEnv, "/env-token"}, want: Connection{"http://localhost:28140", "tok-env-path"},
		},
		{
			name: "пустой экспорт", env: map[string]string{
				"HOME": fixtureHome, "GRIGDESK_ENV_FILE": alternateEnv,
				"GRIGDESK_PORT": "", "GRIGDESK_CLI_TOKEN_PATH": "",
			},
			files: map[string]string{alternateEnv: "GRIGDESK_PORT=18140\nGRIGDESK_CLI_TOKEN_PATH=/ignored\n",
				fixtureToken: "tok-default"},
			reads: []string{alternateEnv, fixtureToken}, want: Connection{"http://localhost:8140", "tok-default"},
		},
		{
			name: "явный токен", env: map[string]string{
				"HOME": fixtureHome, "GRIGDESK_ENV_FILE": alternateEnv, "GRIGDESK_TOKEN": "explicit",
			},
			files: map[string]string{alternateEnv: "GRIGDESK_PORT=18140\n"},
			reads: []string{alternateEnv}, want: Connection{"http://localhost:18140", "explicit"},
		},
		{
			name: "буквальное значение", env: map[string]string{
				"HOME": fixtureHome, "GRIGDESK_ENV_FILE": alternateEnv, "GRIGDESK_URL": "https://example.test",
			},
			files: map[string]string{
				alternateEnv: "GRIGDESK_PORT=65536\nGRIGDESK_CLI_TOKEN_PATH=" + literalTokenPath +
					"\nUNRELATED=`id`\n",
				literalTokenPath: "tok",
			},
			reads: []string{alternateEnv, literalTokenPath}, want: Connection{"https://example.test", "tok"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := configFixture{files: test.files}
			snapshot := maps.Clone(test.env)
			connection, err := ResolveConnection(test.env, fixture.io())
			if err != nil || connection != test.want || !maps.Equal(test.env, snapshot) {
				t.Fatalf("получено %+v, ошибка %v, окружение %v", connection, err, test.env)
			}
			if !slices.Equal(fixture.reads, test.reads) || fixture.homes != test.wantHomes {
				t.Fatalf("чтения %v, количество обращений за домашней папкой %d", fixture.reads, fixture.homes)
			}
		})
	}
}

// TestConfigReadFailure проверяет русские причины отказов файловой системы.
// Старые пути с исходниками отсутствуют среди фактических чтений.
func TestConfigReadFailure(t *testing.T) {
	for _, test := range []struct {
		path, content, want string
		fault               error
		reads               []string
	}{
		{fixtureEnv, "", "Не удалось прочитать настройки: " + fixtureEnv + ".", fs.ErrPermission,
			[]string{fixtureEnv}},
		{fixtureEnv, "", "Не удалось прочитать настройки: " + fixtureEnv + ".", errors.New("EISDIR"),
			[]string{fixtureEnv}},
		{fixtureToken, "", "Нет токена: " + fixtureToken + ".", fs.ErrNotExist, []string{fixtureEnv, fixtureToken}},
		{fixtureToken, "", "Нет токена: " + fixtureToken + ".", fs.ErrPermission,
			[]string{fixtureEnv, fixtureToken}},
		{fixtureToken, "", "Нет токена: " + fixtureToken + ".", errors.New("EISDIR"),
			[]string{fixtureEnv, fixtureToken}},
		{fixtureToken, " \n\t ", "Нет токена: " + fixtureToken + ".", nil, []string{fixtureEnv, fixtureToken}},
		{"/custom/token", "", "Нет токена: /custom/token.", nil, []string{fixtureEnv, "/custom/token"}},
		{"relative/token", "", "Нет токена: relative/token.", nil, []string{fixtureEnv, "relative/token"}},
	} {
		fixture := configFixture{
			files: map[string]string{test.path: test.content, "/code/server/.state/cli-token": "old"},
			fault: map[string]error{test.path: test.fault},
		}
		env := map[string]string{"HOME": fixtureHome}
		if test.path != fixtureEnv && test.path != fixtureToken {
			env["GRIGDESK_CLI_TOKEN_PATH"] = test.path
		}

		_, err := ResolveConnection(env, fixture.io())
		if err == nil || err.Error() != test.want || !slices.Equal(fixture.reads, test.reads) {
			t.Errorf("%s: получено %v, чтения %v", test.path, err, fixture.reads)
		}
	}
}

// TestConfigValidation проверяет отказы до HTTP и значения порта с умолчанием.
// Сообщения ошибок не содержат недопустимый токен или адрес.
func TestConfigValidation(t *testing.T) {
	const address = "Некорректный адрес GrigDesk: нужен HTTP(S) URL без учётных данных и query."
	const port = "Некорректный порт GrigDesk: нужно целое число от 1 до 65535."
	for _, input := range []string{"not a url", "ftp://host/", "http://user:pass@host/", "http://user@host/",
		"http://host/?q=1", "http://host/#frag", "http://host/?", "http://host/#", "file:///etc/passwd"} {
		_, err := ResolveConnection(map[string]string{"GRIGDESK_URL": input, "GRIGDESK_TOKEN": "t"}, ConfigIO{})
		if err == nil || err.Error() != address {
			t.Errorf("для %s получено %v", input, err)
		}
	}
	for _, input := range []string{"   ", "a\nb", "a\rb", "a\x00b"} {
		_, err := ResolveConnection(map[string]string{
			"GRIGDESK_URL": "http://127.0.0.1:1", "GRIGDESK_TOKEN": input,
		}, ConfigIO{})
		if err == nil || err.Error() != "Некорректный токен GrigDesk." || strings.Contains(err.Error(), input) {
			t.Errorf("ошибка токена: %v", err)
		}
	}
	for _, input := range []string{"-1", "1.5", "65536"} {
		_, err := ResolveConnection(map[string]string{"GRIGDESK_PORT": input, "GRIGDESK_TOKEN": "t"},
			(&configFixture{}).io())
		if err == nil || err.Error() != port {
			t.Errorf("порт %q: %v", input, err)
		}
	}
	for _, input := range []string{"abc", "", "0"} {
		connection, err := ResolveConnection(map[string]string{"GRIGDESK_PORT": input, "GRIGDESK_TOKEN": "t"},
			(&configFixture{}).io())
		if err != nil || connection.BaseURL != "http://localhost:8140" {
			t.Errorf("порт %q: %+v, %v", input, connection, err)
		}
	}
	for _, key := range []string{"GRIGDESK_HOME", "GRIGDESK_ENV_FILE"} {
		fixture := configFixture{files: map[string]string{fixtureEnv: key + "=\n"}}
		_, err := ResolveConnection(nil, fixture.io())
		if err == nil || err.Error() != "Ключ "+key+" запрещён в файле настроек." {
			t.Errorf("ключ %q: %v", key, err)
		}
	}
	_, err := ResolveConnection(map[string]string{"GRIGDESK_HOME": "relative"}, (&configFixture{}).io())
	if err == nil || !strings.HasPrefix(err.Error(), "GRIGDESK_HOME должен быть абсолютным путём") {
		t.Errorf("неверный корень: %v", err)
	}
}

// TestParseEnvQuotes сверяет кавычки, комментарии, экспорт и переносы с util.ParseDotenv.
// Повтор ключа использует последнее значение, включая пустое в конце файла.
func TestParseEnvQuotes(t *testing.T) {
	input := "# первая строка\r\nexport PORT = 100 # порт\r\n" +
		"DOUBLE=\"line\\nline\"\nSINGLE='a\nb#c'\nLITERAL=`$(echo ignored)`\n" +
		"broken\nPORT=200\nEMPTY="
	want := map[string]string{
		"PORT": "200", "DOUBLE": "line\nline", "SINGLE": "a\nb#c", "LITERAL": "$(echo ignored)", "EMPTY": "",
	}
	if got := ParseDotenv(input); !maps.Equal(got, want) {
		t.Fatalf("получено %q, ожидали %q", got, want)
	}
}
