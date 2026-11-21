package task

import (
	"bytes"
	"cmp"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"errors"
	"io"
	"math"
	"slices"
	"strconv"
)

type launchProperty struct {
	name  string
	value any
}

type launchObject []launchProperty

// readLaunchBody принимает один целый JSON-объект, включая неизвестные клиенту поля.
// Представление хранит порядок ключей, чтобы в запросе не менять результат JSON.stringify.
func readLaunchBody(stdin io.Reader) (launchObject, error) {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(skipBOM(raw)))
	dec.UseNumber()
	value, err := readLaunchValue(dec)
	if err != nil {
		return nil, err
	}
	object, ok := value.(launchObject)
	if !ok {
		return nil, errors.New("Запуск ожидает JSON-объект.")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("После JSON-объекта есть лишние данные.")
	}
	return object, nil
}

// readLaunchValue сохраняет порядок свойств объектов на любой глубине.
// Числа интерпретируются как в JavaScript, повтор ключа меняет только его значение.
func readLaunchValue(dec *json.Decoder) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch token {
	case json.Delim('{'):
		return readLaunchObject(dec)
	case json.Delim('['):
		values := make([]any, 0)
		for dec.More() {
			value, err := readLaunchValue(dec)
			if err != nil {
				return nil, err
			}
			values = append(values, value)
		}
		_, err := dec.Token()
		return values, err
	}
	if number, ok := token.(json.Number); ok {
		value, _ := number.Float64()
		if math.IsInf(value, 0) {
			return nil, nil
		}
		return value + 0, nil
	}
	return token, nil
}

// readLaunchObject собирает свойства, сохраняя исходную позицию повторяющегося имени.
// Числовой порядок накладывается при выводе, отдельно от остальных ключей.
func readLaunchObject(dec *json.Decoder) (launchObject, error) {
	object := make(launchObject, 0)
	indices := make(map[string]int)
	for dec.More() {
		name, err := dec.Token()
		if err != nil {
			return nil, err
		}
		value, err := readLaunchValue(dec)
		if err != nil {
			return nil, err
		}
		key := name.(string)
		if index, exists := indices[key]; exists {
			object[index].value = value
		} else {
			indices[key] = len(object)
			object = append(object, launchProperty{name: key, value: value})
		}
	}
	_, err := dec.Token()
	return object, err
}

// find возвращает и наличие свойства, чтобы различать отсутствие и JSON null.
// Для проверки source эти состояния дают разные исходы.
func (object launchObject) find(name string) (any, bool) {
	for _, property := range object {
		if property.name == name {
			return property.value, true
		}
	}
	return nil, false
}

// set сохраняет позицию существующего поля при присваивании подтверждённого source.
// Новое поле добавляется после уже прочитанных полей.
func (object *launchObject) set(name string, value any) {
	for index, property := range *object {
		if property.name == name {
			(*object)[index].value = value
			return
		}
	}
	*object = append(*object, launchProperty{name: name, value: value})
}

// MarshalJSON записывает массивоподобные ключи по возрастанию.
// Остальные свойства идут в порядке их появления в исходном объекте.
func (object launchObject) MarshalJSON() ([]byte, error) {
	properties := slices.Clone(object)
	slices.SortStableFunc(properties, func(left, right launchProperty) int {
		return cmp.Compare(jsonPropertyIndex(left.name), jsonPropertyIndex(right.name))
	})

	var out bytes.Buffer
	out.WriteByte('{')
	for i, property := range properties {
		if i > 0 {
			out.WriteByte(',')
		}
		name, err := jsonv2.Marshal(property.name)
		if err != nil {
			return nil, err
		}
		value, err := jsonv2.Marshal(property.value)
		if err != nil {
			return nil, err
		}
		out.Write(name)
		out.WriteByte(':')
		out.Write(value)
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

func jsonPropertyIndex(name string) uint64 {
	index, err := strconv.ParseUint(name, 10, 32)
	if err != nil || strconv.FormatUint(index, 10) != name {
		return math.MaxUint32
	}
	return index
}
