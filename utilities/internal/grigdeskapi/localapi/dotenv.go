package localapi

import "strings"

const envSpace = " \t\n"

// ParseDotenv восстанавливает синтаксис файла Node util.ParseDotenv для настроек tracker.
// Значения остаются строками, без раскрытия переменных и выполнения команд.
func ParseDotenv(text string) map[string]string {
	settings := make(map[string]string)
	text = strings.Trim(strings.ReplaceAll(text, "\r", ""), envSpace)
	for text != "" {
		separator := strings.IndexAny(text, "=\n")
		if text[0] == '\n' || text[0] == '#' {
			_, text, _ = strings.Cut(text, "\n")
			continue
		}
		if separator < 0 {
			break
		}
		if text[separator] == '\n' {
			text = strings.Trim(text[separator+1:], envSpace)
			continue
		}

		key := strings.Trim(text[:separator], envSpace)
		text = text[separator+1:]
		if text == "" || text[0] == '\n' {
			settings[key] = ""
			continue
		}
		text = strings.Trim(text, envSpace)
		if key == "" {
			continue
		}
		key = strings.Trim(strings.TrimPrefix(key, "export "), envSpace)
		settings[key], text = envValue(text)
	}
	return settings
}

// envValue читает одно значение и оставляет хвост файла для разбора следующего ключа.
// Кавычки допускают переносы, а двойные кавычки также раскрывают последовательность \n.
func envValue(text string) (string, string) {
	if text == "" {
		return "", ""
	}
	quote := text[0]
	if quote == '"' || quote == '\'' || quote == '`' {
		end := strings.IndexByte(text[1:], quote)
		if end < 0 {
			value, tail, _ := strings.Cut(text, "\n")
			return value, strings.Trim(tail, envSpace)
		}
		value := text[1 : end+1]
		if quote == '"' {
			value = strings.ReplaceAll(value, `\n`, "\n")
		}
		_, tail, _ := strings.Cut(text[end+2:], "\n")
		return value, tail
	}

	line, tail, _ := strings.Cut(text, "\n")
	value, _, _ := strings.Cut(line, "#")
	return strings.Trim(value, envSpace), strings.Trim(tail, envSpace)
}
