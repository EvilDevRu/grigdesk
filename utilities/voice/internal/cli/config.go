package cli

import (
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strings"

	"github.com/nationallibraryofnorway/whatwg-url/url"

	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

type configuration struct {
	Service string
	Key     string
	Base    string
	Dir     string
}

// voiceConfig читает только аргументы и переданные переменные окружения.
// Файловые настройки сервера не участвуют в выборе каталога и ключа.
func voiceConfig(flags map[string]string, env map[string]string) (configuration, error) {
	service := localapi.TrimSpace(first(flags["--service"], env["GRIGDESK_VOICE_QWEN_SERVICE"], "model-studio"))
	if service != "model-studio" && service != "qwencloud-token" {
		const message = "Неизвестный сервис Qwen: выберите model-studio или qwencloud-token."
		return configuration{}, voicecore.Usage(message)
	}
	tokenKey, fallback := "", "https://dashscope-intl.aliyuncs.com"
	if service == "qwencloud-token" {
		tokenKey, fallback = env["TOKEN_PLAN_API_KEY"], "https://token-plan.maas.qwencloudapi.com"
	}
	raw := first(flags["--api-key"], env["GRIGDESK_VOICE_QWEN_API_KEY"], tokenKey, env["DASHSCOPE_API_KEY"])
	if strings.ContainsAny(raw, "\r\n\x00") {
		return configuration{}, voicecore.Failed("Ключ Qwen содержит недопустимые управляющие символы.")
	}
	base, err := qwenBase(first(env["GRIGDESK_VOICE_QWEN_BASE_URL"], fallback))
	if err != nil {
		return configuration{}, err
	}
	home, _ := os.UserHomeDir()
	if home == "" {
		if current, err := user.Current(); err == nil {
			home = current.HomeDir
		}
	}
	root := first(flags["--dir"], env["GRIGDESK_VOICE_DIR"], filepath.Join(home, ".grigdesk", "voice"))
	directory, err := filepath.Abs(root)
	return configuration{Service: service, Key: localapi.TrimSpace(raw), Base: base, Dir: directory}, err
}

// qwenBase разрешает только HTTP(S) и проверяет учётные данные в адресе.
// Значение ошибки описывает форму и не включает исходный адрес пользователя.
func qwenBase(value string) (string, error) {
	address, err := url.Parse(localapi.TrimSpace(value))
	if err != nil {
		return "", voicecore.Usage("Некорректный GRIGDESK_VOICE_QWEN_BASE_URL.")
	}
	if address.Scheme() != "http" && address.Scheme() != "https" ||
		address.Username() != "" || address.Password() != "" {
		return "", voicecore.Usage("Адрес Qwen должен быть HTTP(S) без имени пользователя и пароля.")
	}
	if len(address.Query()) > 0 || len(address.Fragment()) > 0 {
		return "", voicecore.Usage("Адрес Qwen не должен содержать query или fragment.")
	}
	return strings.TrimRight(address.Href(false), "/"), nil
}

func first(values ...string) string {
	for _, value := range values {
		if localapi.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// redact удаляет исходные и обрезанные ключи из любых ожидаемых исключений.
// Сначала заменяются более длинные варианты, чтобы не раскрыть часть совпадения.
func redact(message string, secrets ...string) string {
	values := make([]string, 0, len(secrets)*2)
	for _, secret := range secrets {
		if secret != "" {
			values = append(values, secret)
		}
		if trimmed := localapi.TrimSpace(secret); trimmed != "" && trimmed != secret {
			values = append(values, trimmed)
		}
	}
	slices.SortStableFunc(values, func(a, b string) int { return len(b) - len(a) })
	for _, value := range values {
		message = strings.ReplaceAll(message, value, "[ключ скрыт]")
	}
	return message
}
