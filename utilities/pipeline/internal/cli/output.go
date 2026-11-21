package cli

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"fmt"
	"slices"
	"strconv"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"grigdesk.local/tools/utilities/pipeline/internal/control"
)

// formatOutput оборачивает опции запуска с отпечатком и дополняет документ основанием.
// Прочие ответы API остаются в переданном порядке ключей.
func formatOutput(name string, values map[string]string, raw []byte, value any) (any, error) {
	switch name {
	case "launch-options":
		hash, err := snapshotHash(value)
		return struct {
			Options json.RawMessage `json:"options"`
			Hash    string          `json:"expectedLaunch"`
		}{Options: raw, Hash: hash}, err
	case "doc":
		return formatDocument(values["doc"], raw, value)
	default:
		return json.RawMessage(raw), nil
	}
}

// formatDocument добавляет basis к полному ответу, сохраняя переданные сервером поля.
// Отпечаток считается по JSON-строке неизменённого текста, а не по байтам файла.
func formatDocument(name string, raw []byte, value any) (any, error) {
	row, _ := value.(map[string]any)
	text, ok := row["text"].(string)
	if !ok {
		return nil, &control.Failure{Code: 22, Text: "API документа не вернул text"}
	}
	hash, err := snapshotHash(text)
	if err != nil {
		return nil, err
	}
	basis := struct {
		Name string `json:"name"`
		Hash string `json:"hash"`
	}{Name: name, Hash: hash}
	if _, exists := row["basis"]; exists {
		row["basis"] = basis
		return row, nil
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, err
	}
	encoded, err := jsonv2.Marshal(basis)
	if err != nil {
		return nil, err
	}
	object := compact.Bytes()
	return json.RawMessage(fmt.Sprintf("%s,\"basis\":%s}", object[:len(object)-1], encoded)), nil
}

// snapshotHash упорядочивает вложенные ключи по правилам отпечатка factory.
// Массивы сохраняют исходный порядок, индексные свойства идут перед остальными.
func snapshotHash(value any) (string, error) {
	var output bytes.Buffer
	if err := canonical(&output, collate.New(language.English), value); err != nil {
		return "", err
	}
	digest := sha256.Sum256(output.Bytes())
	return hex.EncodeToString(digest[:]), nil
}

// canonical сериализует JSON с упорядоченными объектами без пробелов.
// Коллатор передаётся через все уровни одного вызова для согласованной сортировки.
func canonical(output *bytes.Buffer, order *collate.Collator, value any) error {
	switch row := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(row))
		for name := range row {
			keys = append(keys, name)
		}
		slices.SortFunc(keys, func(left, right string) int {
			return compareKeys(order, left, right)
		})
		output.WriteByte('{')
		for i, name := range keys {
			if i > 0 {
				output.WriteByte(',')
			}
			encoded, err := jsonv2.Marshal(name)
			if err != nil {
				return err
			}
			output.Write(encoded)
			output.WriteByte(':')
			if err := canonical(output, order, row[name]); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	case []any:
		output.WriteByte('[')
		for i, item := range row {
			if i > 0 {
				output.WriteByte(',')
			}
			if err := canonical(output, order, item); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	default:
		encoded, err := jsonv2.Marshal(value)
		if err != nil {
			return err
		}
		output.Write(encoded)
	}
	return nil
}

// compareKeys учитывает перечисление индексных ключей JSON-объекта до строковых.
// Остальные сравниваются обычной коллацией, которой пользуется factory.
func compareKeys(order *collate.Collator, left, right string) int {
	a, aIndex := indexKey(left)
	b, bIndex := indexKey(right)
	if aIndex && bIndex {
		return int(a) - int(b)
	}
	if aIndex {
		return -1
	}
	if bIndex {
		return 1
	}
	return order.CompareString(left, right)
}

func indexKey(key string) (uint64, bool) {
	number, err := strconv.ParseUint(key, 10, 32)
	return number, err == nil && number < 1<<32-1 && strconv.FormatUint(number, 10) == key
}

// partial проверяет квитанцию сохранения отдельно от запуска следующей стадии.
// При частичном выполнении сохраняется полное тело ответа.
func partial(command string, value any) bool {
	row, _ := value.(map[string]any)
	receipt, _ := row["receipt"].(map[string]any)
	return (command == "gate" || command == "goto") && row["resumed"] == false ||
		command == "runner-set" && receipt["state"] == "failed" ||
		(command == "arbiter-apply" || command == "arbiter-resume") && row["outcome"] == "resume_failed"
}
