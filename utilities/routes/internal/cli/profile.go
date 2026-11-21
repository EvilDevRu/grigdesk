package cli

import (
	"encoding/json"
	"net/http"
	"strings"
)

type profileVariable struct {
	Name     string          `json:"name"`
	Value    json.RawMessage `json:"value"`
	Editable bool            `json:"editable"`
}

type profileChange struct {
	Name string          `json:"name"`
	From json.RawMessage `json:"from"`
	To   string          `json:"to"`
}

// profileConfig читает значения из whitelisted конфигурации профиля.
// Парные изначальные значения передаются в одном PATCH для CAS-проверки.
func (run invocation) profileConfig(action string) error {
	base := "/api/profiles/" + run.profile
	if action == "get" {
		return run.show(http.MethodGet, base+"/config", nil)
	}
	if action != "set" {
		return usage("profile-config <get|set> <профиль> [--file profile.sh|dashboard.env] [--set NAME=VALUE…]")
	}
	file := run.flags.valueOr("file", "profile.sh")
	if _, present := run.flags["file"]; present {
		value, stringValue := run.flags.single("file")
		if !stringValue || value != "profile.sh" && value != "dashboard.env" {
			return usage("--file: profile.sh или dashboard.env")
		}
	}
	value, err := run.call(http.MethodGet, base+"/config", nil)
	if err != nil {
		return err
	}
	changes, err := run.profileChanges(file, value)
	if err != nil {
		return err
	}
	body := struct {
		File    string          `json:"file"`
		Changes []profileChange `json:"changes"`
	}{File: file, Changes: changes}
	return run.show(http.MethodPatch, base+"/variables", body)
}

// profileChanges ищет каждое имя в разделе выбранного файла.
// Доступное отсутствующее значение остаётся null, закрытое поле не участвует в записи.
func (run invocation) profileChanges(file string, value json.RawMessage) ([]profileChange, error) {
	var config struct {
		Variables struct {
			Profile   []profileVariable `json:"profileSh"`
			Dashboard []profileVariable `json:"dashboard"`
		} `json:"variables"`
	}
	if err := json.Unmarshal(value, &config); err != nil {
		return nil, err
	}
	entries := config.Variables.Profile
	if file == "dashboard.env" {
		entries = config.Variables.Dashboard
	}
	byName := make(map[string]profileVariable, len(entries))
	for _, entry := range entries {
		byName[entry.Name] = entry
	}
	var changes []profileChange
	for _, field := range run.flags["set"] {
		pair := flagText(field)
		if pair == "" {
			continue
		}
		name, setting, hasValue := strings.Cut(pair, "=")
		if !hasValue || name == "" {
			return nil, usage("ожидается NAME=VALUE: " + pair)
		}
		entry := byName[name]
		if !entry.Editable {
			return nil, usage("переменная недоступна для записи: " + name)
		}
		changes = append(changes, profileChange{Name: name, From: entry.Value, To: setting})
	}
	if len(changes) == 0 {
		return nil, usage("нужен хотя бы один --set NAME=VALUE")
	}
	return changes, nil
}
