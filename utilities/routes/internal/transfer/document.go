package transfer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

type Route struct {
	ID      string
	Route   json.RawMessage
	Prompts json.RawMessage
}

type Document struct {
	Routes           []Route
	Bootstrap        json.RawMessage
	BootstrapPrompts json.RawMessage
	Presentation     json.RawMessage
	Provenance       json.RawMessage
}

// Read читает один авторский JSON-файл с диска до любых изменений на сервере.
// Сырой документ используется также при импорте версии transfer.
func Read(file string) (json.RawMessage, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("не удалось прочитать JSON: %w", err)
	}
	if !json.Valid(data) {
		return nil, errors.New("не удалось прочитать JSON: некорректный документ")
	}
	return data, nil
}

// Content проверяет обязательные пять полей до чтения текущего черновика.
// Поля полного снимка show, которые не принадлежат контенту, пропускаются.
func Content(data json.RawMessage) (Document, error) {
	const missing = "нужны все пять полей авторского контента"
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return Document{}, errors.New(missing)
	}
	for _, key := range []string{"routes", "bootstrapPrompts", "presentation", "provenance"} {
		if !isObject(fields[key]) {
			return Document{}, errors.New(missing)
		}
	}
	if !isObject(fields["bootstrap"]) && !bytes.Equal(bytes.TrimSpace(fields["bootstrap"]), []byte("null")) {
		return Document{}, errors.New(missing)
	}

	routes, err := Routes(fields["routes"], true)
	if err != nil {
		return Document{}, err
	}
	return Document{
		Routes:           routes,
		Bootstrap:        fields["bootstrap"],
		BootstrapPrompts: fields["bootstrapPrompts"],
		Presentation:     fields["presentation"],
		Provenance:       fields["provenance"],
	}, nil
}

// Routes считывает маршруты в порядке свойств документа, учитывая последний дубликат.
// При сравнении текущего снимка требуются только имена. Авторский ввод проверяет также тела.
func Routes(data json.RawMessage, validate bool) ([]Route, error) {
	if !isObject(data) {
		return nil, errors.New("Снимок маршрутов должен содержать объект routes.")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	_, _ = dec.Token()
	var routes []Route
	indices := make(map[string]int)
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil, err
		}
		id := key.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		route := Route{ID: id}
		if validate {
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(raw, &fields); err != nil ||
				!isObject(fields["route"]) || !isObject(fields["prompts"]) {
				return nil, errors.New("маршрут должен содержать route и prompts")
			}
			route.Route, route.Prompts = fields["route"], fields["prompts"]
		}
		if index, exists := indices[id]; exists {
			routes[index] = route
		} else {
			indices[id] = len(routes)
			routes = append(routes, route)
		}
	}
	_, err := dec.Token()
	return routes, err
}

func isObject(data []byte) bool {
	data = bytes.TrimSpace(data)
	return len(data) != 0 && data[0] == '{'
}
