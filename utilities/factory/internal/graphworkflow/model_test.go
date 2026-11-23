package graphworkflow

import (
	"strings"
	"testing"
)

func TestDefinitionRejectsUnavailableDependencies(t *testing.T) {
	template := `{"title":"Проверка","inputKind":"documents","scope":{"returns":["out"],"steps":[%s]}}`
	cases := []struct {
		name, steps, field string
	}{
		{"цикл", `{"id":"a","title":"A","kind":"join","needs":["out"]},
		{"id":"out","title":"B","kind":"join","needs":["a"]}`, "cycle"},
		{"чужая область", `{"id":"out","title":"B","kind":"join","needs":["outside"]}`, "needs"},
		{"невозможный кворум", `{"id":"a","title":"A","kind":"input"},
		{"id":"out","title":"B","kind":"join","needs":["a"],"mode":"quorum","minSuccess":2}`, "minSuccess"},
		{"ссылка без зависимости", `{"id":"a","title":"A","kind":"input"},
		{"id":"out","title":"B","kind":"forEach","source":"a",
		"scope":{"returns":["x"],"steps":[{"id":"x","title":"X","kind":"input"}]}}`, "source"},
		{"свободная команда", `{"id":"out","title":"B","kind":"agent","prompt":"работай",
		"command":"some-program"}`, "command"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := strings.Replace(template, "%s", tc.steps, 1)
			if _, err := DecodeDefinition([]byte(raw)); err == nil || !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("ожидается отказ с полем %s, получено %v", tc.field, err)
			}
		})
	}
}

func TestDefinitionAcceptsNestedGraph(t *testing.T) {
	raw := []byte(`{
		"title":"Пакет","inputKind":"documents","scope":{
			"returns":["out"],"steps":[
				{"id":"out","title":"Сборка","kind":"join","needs":["documents","check"],"mode":"all"},
				{"id":"documents","title":"По документу","kind":"forEach","source":"check","needs":["check"],
				"scope":{"returns":["work"],"steps":[{"id":"work","title":"Обработка",
				"kind":"agent","reads":["$item"],"prompt":"Приведи краткое содержание"}]}},
				{"id":"check","title":"Комплект","kind":"input"}
			]
		}
	}`)
	definition, err := DecodeDefinition(raw)
	if err != nil || len(definition.Scope.Steps) != 3 || definition.Scope.Steps[1].Scope == nil {
		t.Fatalf("не принят вложенный граф: %+v, %v", definition, err)
	}
}
