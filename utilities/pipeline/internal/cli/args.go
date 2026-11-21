package cli

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"grigdesk.local/tools/utilities/pipeline/internal/control"
)

type commandSpec struct {
	method   string
	path     string
	params   string
	defaults map[string]string
}

var commands = map[string]commandSpec{
	"list":     {method: http.MethodGet, path: "/api/tasks?sources=1"},
	"status":   {method: http.MethodGet, path: "/api/tasks/{task}", params: "task"},
	"state":    {method: http.MethodGet, path: "/api/tasks/{task}/mobile-state", params: "task"},
	"graph":    {method: http.MethodGet, path: "/api/tasks/{task}/graph", params: "task"},
	"doc":      {method: http.MethodGet, path: "/api/tasks/{task}/doc/{doc}", params: "task doc"},
	"profiles": {method: http.MethodGet, path: "/api/profiles"},
	"runners":  {method: http.MethodGet, path: "/api/factory/runners"},
	"slots":    {method: http.MethodGet, path: "/api/factory/slots?profile={profile}", params: "profile"},
	"source":   {method: http.MethodGet, path: "/api/tracker/{board}/context", params: "board"},
	"launch-options": {
		method: http.MethodGet,
		path:   "/api/tasks/{task}/launch-options?profile={profile}&source={source}",
		params: "task profile source",
	},
	"launch": {method: http.MethodPost, path: "/api/tasks/{task}/launch", params: "task"},
	"stop":   {method: http.MethodPost, path: "/api/tasks/{task}/stop", params: "task"},
	"resume": {method: http.MethodPost, path: "/api/tasks/{task}/resume", params: "task"},
	"goto": {
		method: http.MethodPost,
		path:   "/api/tasks/{task}/stage/{key}/running",
		params: "task key",
	},
	"gate": {
		method: http.MethodPost,
		path:   "/api/tasks/{task}/gate/{key}/{decision}",
		params: "task key decision",
	},
	"prelude-state": {method: http.MethodGet, path: "/api/tasks/{task}/prelude-state", params: "task"},
	"runner-options": {
		method: http.MethodGet,
		path: "/api/tasks/{task}/runner/options?profile={profile}&attempt={attempt}&node={node}" +
			"&stage={stage}&provider={provider}",
		params: "task profile attempt node stage provider",
	},
	"runner-set":       {method: http.MethodPost, path: "/api/tasks/{task}/runner/settings", params: "task"},
	"bootstrap-answer": {method: http.MethodPost, path: "/api/tasks/{task}/bootstrap-answer", params: "task"},
	"runtime-rebind":   {method: http.MethodPost, path: "/api/tasks/{task}/runtime-rebind", params: "task"},
	"arbiter-current":  {method: http.MethodGet, path: arbiterPath + "/current", params: "task"},
	"arbiter-show": {
		method:   http.MethodGet,
		path:     arbiterPath + "/{conversation}?afterSequence={afterSequence}&knownRevision={knownRevision}",
		params:   "task conversation afterSequence knownRevision",
		defaults: map[string]string{"afterSequence": "0", "knownRevision": "0"},
	},
	"arbiter-journal": {
		method: http.MethodGet,
		path:   arbiterPath + "/{conversation}/journal",
		params: "task conversation",
	},
	"arbiter-start":    {method: http.MethodPost, path: arbiterPath, params: "task"},
	"arbiter-message":  arbiterMutation("/messages"),
	"arbiter-diagnose": arbiterMutation("/diagnose"),
	"arbiter-apply":    arbiterMutation("/apply"),
	"arbiter-resume":   arbiterMutation("/resume"),
	"arbiter-stop":     {method: http.MethodPost, path: arbiterPath + "/stop", params: "task"},
	"wait": {
		method:   http.MethodGet,
		params:   "task attempt timeoutMs intervalMs",
		defaults: map[string]string{"timeoutMs": "600000", "intervalMs": "2000"},
	},
}

const arbiterPath = "/api/tasks/{task}/arbiter-conversations"

func arbiterMutation(suffix string) commandSpec {
	return commandSpec{
		method: http.MethodPost,
		path:   arbiterPath + "/{conversation}" + suffix,
		params: "task conversation",
	}
}

// arguments разбирает параметры в порядке, закреплённом за командой.
// Проверка точной формы завершает работу до stdin, файлов и запроса.
func (spec commandSpec) arguments(args []string) (map[string]string, error) {
	names := strings.Fields(spec.params)
	if len(args) < len(names)-len(spec.defaults) || len(args) > len(names) {
		return nil, control.Usage("Неверное число аргументов команды pipeline.")
	}
	values := make(map[string]string, len(names))
	for i, name := range names {
		value := spec.defaults[name]
		if i < len(args) {
			value = args[i]
		}
		if !control.Matches(name, value) {
			if name == "source" {
				return nil, control.Usage("Укажите полный подтверждённый source.")
			}
			return nil, control.Usage("Некорректный параметр pipeline: " + name + ".")
		}
		values[name] = value
	}
	if integer(values["timeoutMs"]) > 86400000 || integer(values["intervalMs"]) > 60000 {
		return nil, control.Usage("Слишком большой срок или интервал wait.")
	}
	return values, nil
}

// endpoint подставляет только уже проверенные параметры закрытого шаблона API.
// Значение не может расширить сегмент пути или самовольно добавить параметры запроса.
func (spec commandSpec) endpoint(values map[string]string) string {
	path := spec.path
	for name, value := range values {
		path = strings.ReplaceAll(path, "{"+name+"}", url.QueryEscape(value))
	}
	return path
}

func integer(value string) int {
	number, _ := strconv.Atoi(value)
	return number
}
