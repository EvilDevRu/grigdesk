package state

import (
	"encoding/json"
	"encoding/json/jsontext"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	lifecycleIntegerMax = 9007199254740991
	lifecycleValueLimit = 100000
	lifecycleDepthLimit = 64
	lifecycleLineLimit  = 64 * 1024
)

// lifecycleKeyOrder сравнивает кодовые единицы UTF-16, как исходный ledger.
// Это часть вычисления хэша события, а не порядок вывода в диагностике.
func lifecycleKeyOrder(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}

// lifecycleString обрабатывает уже проверенную строку JSON.
// Символы HTML и Unicode-разделители остаются буквальными.
func lifecycleString(value string) string {
	const hex = "0123456789abcdef"
	var output strings.Builder
	output.WriteByte('"')
	for _, char := range value {
		switch char {
		case '"', '\\':
			output.WriteByte('\\')
			output.WriteRune(char)
		case '\b':
			output.WriteString(`\b`)
		case '\f':
			output.WriteString(`\f`)
		case '\n':
			output.WriteString(`\n`)
		case '\r':
			output.WriteString(`\r`)
		case '\t':
			output.WriteString(`\t`)
		default:
			if char < 32 {
				output.WriteString(`\u00`)
				output.WriteByte(hex[char>>4])
				output.WriteByte(hex[char&15])
			} else {
				output.WriteRune(char)
			}
		}
	}
	output.WriteByte('"')
	return output.String()
}

// parseLifecycleRecord отклоняет дубли JSON-ключей и непарные surrogate escapes.
// Канонический кодек отдельно проверяет тип чисел и бюджет дерева.
func parseLifecycleRecord(data []byte, limit int) (record, error) {
	if len(data) > limit || !jsontext.Value(data).IsValid() {
		return nil, fmt.Errorf("lifecycle: неверный UTF-8, JSON или предел размера")
	}
	value, err := decodeRecord(data)
	if err != nil {
		return nil, err
	}
	if _, err := lifecycleBytes(value, limit); err != nil {
		return nil, err
	}
	return value, nil
}

type lifecycleEncoder struct {
	output strings.Builder
	values int
	limit  int
}

// lifecycleBytes получает compact JSON для хэшей и append.
// Кодек не применяется к attempt metadata и stage checksum.
func lifecycleBytes(value any, limit int) ([]byte, error) {
	encoder := lifecycleEncoder{limit: limit}
	if err := encoder.write(value, 0); err != nil {
		return nil, err
	}
	return []byte(encoder.output.String()), nil
}

// write ограничивает глубину, количество значений и размер сериализации.
// Любое число должно быть точным целым в IEEE-754 safe integer.
func (e *lifecycleEncoder) write(value any, depth int) error {
	e.values++
	if e.values > lifecycleValueLimit || depth > lifecycleDepthLimit {
		return fmt.Errorf("lifecycle: превышен предел структуры JSON")
	}
	switch value := value.(type) {
	case nil:
		e.output.WriteString("null")
	case bool:
		e.output.WriteString(strconv.FormatBool(value))
	case string:
		if !utf8.ValidString(value) {
			return fmt.Errorf("lifecycle: неверный UTF-8")
		}
		e.output.WriteString(lifecycleString(value))
	case json.Number:
		number, err := value.Int64()
		if err != nil || number < -lifecycleIntegerMax || number > lifecycleIntegerMax {
			return fmt.Errorf("lifecycle: допустимы только safe integer")
		}
		e.output.WriteString(strconv.FormatInt(number, 10))
	case record:
		if err := e.writeObject(value, depth); err != nil {
			return err
		}
	case []any:
		if err := e.writeArray(value, depth); err != nil {
			return err
		}
	default:
		return fmt.Errorf("lifecycle: недопустимый тип значения %T", value)
	}
	if e.output.Len() > e.limit {
		return fmt.Errorf("lifecycle: превышен предел %d байт", e.limit)
	}
	return nil
}

// writeObject сортирует отдельно каждые вложенные имена.
// Неправильная строка ключа исключается до вычисления порядка.
func (e *lifecycleEncoder) writeObject(value record, depth int) error {
	keys := make([]string, 0, len(value))
	for key := range value {
		if !utf8.ValidString(key) {
			return fmt.Errorf("lifecycle: неверный UTF-8 в имени поля")
		}
		keys = append(keys, key)
	}
	slices.SortFunc(keys, lifecycleKeyOrder)
	e.output.WriteByte('{')
	for index, key := range keys {
		if index > 0 {
			e.output.WriteByte(',')
		}
		e.output.WriteString(lifecycleString(key))
		e.output.WriteByte(':')
		if err := e.write(value[key], depth+1); err != nil {
			return err
		}
	}
	e.output.WriteByte('}')
	return nil
}

// writeArray сохраняет исходный порядок элементов.
// Элементы используют общий бюджет с окружающим документом.
func (e *lifecycleEncoder) writeArray(value []any, depth int) error {
	e.output.WriteByte('[')
	for index, item := range value {
		if index > 0 {
			e.output.WriteByte(',')
		}
		if err := e.write(item, depth+1); err != nil {
			return err
		}
	}
	e.output.WriteByte(']')
	return nil
}
