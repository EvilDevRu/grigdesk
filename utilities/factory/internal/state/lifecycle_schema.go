package state

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

//go:embed schema/lifecycle-event.schema.json
var lifecycleSchema []byte

type lifecycleContract struct {
	schema   record
	refs     record
	patterns map[string]*regexp.Regexp
}

var loadLifecycleContract = sync.OnceValues(func() (lifecycleContract, error) {
	return parseLifecycleContract(lifecycleSchema)
})

// parseLifecycleContract подготавливает закрытую схему одного формата аналитики.
// Все ссылки остаются внутри одного встроенного документа.
func parseLifecycleContract(data []byte) (lifecycleContract, error) {
	schema, err := decodeRecord(data)
	if err != nil {
		return lifecycleContract{}, err
	}
	contract := lifecycleContract{schema: schema, refs: objectField(schema, "$defs"),
		patterns: make(map[string]*regexp.Regexp)}
	contract.collectPatterns(schema)
	return contract, nil
}

// collectPatterns компилирует выражения неизменяемой схемы.
// При чтении журнала остаются только проверки значений и точных типов.
func (c lifecycleContract) collectPatterns(value any) {
	switch value := value.(type) {
	case record:
		if pattern, ok := value["pattern"].(string); ok {
			c.patterns[pattern] = regexp.MustCompile(pattern)
		}
		for _, item := range value {
			c.collectPatterns(item)
		}
	case []any:
		for _, item := range value {
			c.collectPatterns(item)
		}
	}
}

func objectField(value record, key string) record {
	result, _ := value[key].(record)
	return result
}

func arrayField(value record, key string) []any {
	result, _ := value[key].([]any)
	return result
}

func integerField(value record, key string) int64 {
	number, _ := value[key].(json.Number)
	parsed, _ := number.Int64()
	return parsed
}

// validateLifecycleSchema применяет только поля закреплённой схемы lifecycle.
// Проверка времени включает календарную дату, а routeId и hash образуют пару.
func validateLifecycleSchema(event record) error {
	contract, err := loadLifecycleContract()
	if err != nil {
		return err
	}
	if !contract.matches(event, contract.schema) {
		return fmt.Errorf("lifecycle: событие не соответствует канонической схеме")
	}
	const timeFormat = "2006-01-02T15:04:05.000Z"
	at := stringField(event, "at")
	if parsed, err := time.Parse(timeFormat, at); err != nil || parsed.Format(timeFormat) != at {
		return fmt.Errorf("lifecycle: неверный UTC timestamp")
	}
	if (event["routeId"] == nil) != (event["routeHash"] == nil) {
		return fmt.Errorf("lifecycle: routeId и hash должны быть закреплены вместе")
	}
	return nil
}

// matches вычисляет проверку узла JSON schema.
// Узел может ссылаться на локальные defs и сочетать условия по виду события.
func (c lifecycleContract) matches(value any, schema record) bool {
	if schema == nil {
		return false
	}
	if ref, ok := schema["$ref"].(string); ok {
		name, known := strings.CutPrefix(ref, "#/$defs/")
		if !known || !c.matches(value, objectField(c.refs, name)) {
			return false
		}
	}
	if expected, exists := schema["const"]; exists && !reflect.DeepEqual(value, expected) {
		return false
	}
	if values, exists := schema["enum"].([]any); exists {
		found := false
		for _, choice := range values {
			found = found || reflect.DeepEqual(value, choice)
		}
		if !found {
			return false
		}
	}
	if kind, exists := schema["type"].(string); exists && !schemaKind(value, kind) {
		return false
	}
	if !c.combinators(value, schema) {
		return false
	}
	switch value := value.(type) {
	case record:
		return c.matchObject(value, schema)
	case string:
		return c.matchText(value, schema)
	case []any:
		return c.matchArray(value, schema)
	case json.Number:
		number, err := value.Int64()
		return err == nil && schemaBounds(number, schema, "minimum", "maximum")
	}
	return true
}

// combinators применяет независимые правила и только выбранную ветвь if.
// OneOf требует ровно один допустимый вариант.
func (c lifecycleContract) combinators(value any, schema record) bool {
	for _, raw := range arrayField(schema, "allOf") {
		variant, _ := raw.(record)
		if !c.matches(value, variant) {
			return false
		}
	}
	if choices := arrayField(schema, "oneOf"); choices != nil {
		count := 0
		for _, raw := range choices {
			if variant, _ := raw.(record); c.matches(value, variant) {
				count++
			}
		}
		if count != 1 {
			return false
		}
	}
	if condition := objectField(schema, "if"); condition != nil {
		name := "else"
		if c.matches(value, condition) {
			name = "then"
		}
		if branch := objectField(schema, name); branch != nil && !c.matches(value, branch) {
			return false
		}
	}
	return true
}

// schemaKind различает допустимые примитивы закреплённого формата.
// integer не совпадает со строкой, bool или десятичной записью.
func schemaKind(value any, kind string) bool {
	switch kind {
	case "object":
		_, ok := value.(record)
		return ok
	case "string":
		_, ok := value.(string)
		return ok
	case "integer":
		number, _ := value.(json.Number)
		_, err := number.Int64()
		return err == nil
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "null":
		return value == nil
	default:
		return false
	}
}

// matchObject проверяет обязательные ключи и подчинённые свойства.
// Запрет additionalProperties применяется к неизвестным ключам.
func (c lifecycleContract) matchObject(value, schema record) bool {
	for _, field := range arrayField(schema, "required") {
		if name, _ := field.(string); !hasRecordField(value, name) {
			return false
		}
	}
	properties := objectField(schema, "properties")
	for name, item := range value {
		child := objectField(properties, name)
		if child == nil {
			if schema["additionalProperties"] == false {
				return false
			}
		} else if !c.matches(item, child) {
			return false
		}
	}
	return true
}

func hasRecordField(value record, key string) bool {
	_, ok := value[key]
	return ok
}

// matchText сверяет Unicode-длину и синтаксис отдельно.
// Паттерн уже скомпилирован из проверенной версии schema.
func (c lifecycleContract) matchText(value string, schema record) bool {
	if !schemaBounds(int64(utf8.RuneCountInString(value)), schema, "minLength", "maxLength") {
		return false
	}
	if pattern := stringField(schema, "pattern"); pattern != "" {
		return c.patterns[pattern].MatchString(value)
	}
	return true
}

// matchArray применяет схему элемента и ограничение уникальности.
// Каноническое представление определяет эквивалентность составных значений.
func (c lifecycleContract) matchArray(value []any, schema record) bool {
	if !schemaBounds(int64(len(value)), schema, "minItems", "maxItems") {
		return false
	}
	items := objectField(schema, "items")
	unique := schema["uniqueItems"] == true
	seen := make(map[string]bool)
	for _, item := range value {
		if items != nil && !c.matches(item, items) {
			return false
		}
		if unique {
			raw, err := lifecycleBytes(item, lifecycleLineLimit)
			if err != nil || seen[string(raw)] {
				return false
			}
			seen[string(raw)] = true
		}
	}
	return true
}

// schemaBounds применяет только переданные min/max ограничения.
// Интервалы чисел и длин представлены в схеме целыми.
func schemaBounds(value int64, schema record, low, high string) bool {
	if hasRecordField(schema, low) && value < integerField(schema, low) {
		return false
	}
	return !hasRecordField(schema, high) || value <= integerField(schema, high)
}
