package i18n

import (
	"embed"
	"encoding/json"
	"strings"
)

//go:embed assets/locales/ru/cli.json assets/locales/en/cli.json
var cliAssets embed.FS

type CLI map[string]any

// CLIForEnvironment использует первую установленную локаль терминала.
func CLIForEnvironment(env map[string]string) CLI {
	language := "ru"
	for _, key := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if value := strings.ToLower(env[key]); value != "" {
			if !strings.HasPrefix(value, "ru") {
				language = "en"
			}
			break
		}
	}
	bundle, _ := cliAssets.ReadFile("assets/locales/" + language + "/cli.json")
	var translation CLI
	_ = json.Unmarshal(bundle, &translation)
	return translation
}

// Text читает ключ из общей описи локализации CLI.
func (language CLI) Text(key string) string {
	var value any = map[string]any(language)
	for part := range strings.SplitSeq(key, ".") {
		object, ok := value.(map[string]any)
		if !ok {
			return key
		}
		value = object[part]
	}
	text, ok := value.(string)
	if !ok {
		return key
	}
	return text
}
