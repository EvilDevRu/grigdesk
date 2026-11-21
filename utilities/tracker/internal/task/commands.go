package task

import (
	"bytes"
	"context"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

type Command struct {
	Kind  string
	Board string
	ID    string
	Value string
}

type CommandError struct {
	Code int
	Text string
}

func (err *CommandError) Error() string {
	return err.Text
}

type Sender func(context.Context, Connection, RequestSpec) ([]byte, error)

var (
	sourcePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*@[a-f0-9]{64}$`)
	segmentEscape = strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*")
	queryEscape   = strings.NewReplacer("~", "%7E", "%2A", "*")
)

// Execute отправляет запросы выбранной команды и возвращает один готовый результат.
// Для start сначала завершается renew. Его HTTP-отказ не мешает запуску таймера.
func Execute(
	ctx context.Context, command Command, connection Connection, stdin io.Reader, send Sender,
) ([]byte, error) {
	switch command.Kind {
	case "boards":
		return boards(ctx, connection, send)
	case "analyze", "launch-options", "launch":
		return pipeline(ctx, command, connection, stdin, send)
	case "start":
		base := taskPath(command)
		_, err := send(ctx, connection, RequestSpec{Method: http.MethodPost, Path: base + "/renew"})
		var httpFailure *HTTPError
		if err != nil && !errors.As(err, &httpFailure) {
			return nil, err
		}
		return send(ctx, connection, RequestSpec{Method: http.MethodPost, Path: base + "/timer/start"})
	default:
		spec, err := requestSpec(command, stdin)
		if err != nil {
			return nil, err
		}
		return send(ctx, connection, spec)
	}
}

func trackerPath(board string) string {
	if board == "" {
		return "/api/tracker"
	}
	return "/api/tracker/" + encodeSegment(board)
}

func taskPath(command Command) string {
	return trackerPath(command.Board) + "/task/" + encodeSegment(command.ID)
}

func encodeSegment(value string) string {
	return segmentEscape.Replace(url.QueryEscape(value))
}

func encodeQuery(value string) string {
	return queryEscape.Replace(url.QueryEscape(value))
}

// requestSpec строит один запрос обычной операции доски.
// Create передаёт сырые байты stdin, а POST без данных не получает JSON-заголовок.
func requestSpec(command Command, stdin io.Reader) (RequestSpec, error) {
	get := http.MethodGet
	post := http.MethodPost
	base := trackerPath(command.Board)
	path := taskPath(command)

	switch command.Kind {
	case "dashboard":
		return RequestSpec{Method: get, Path: base + "/dashboard"}, nil
	case "task":
		return RequestSpec{Method: get, Path: path}, nil
	case "comment":
		payload := struct {
			Text string `json:"text"`
		}{Text: command.Value}
		body, err := jsonv2.Marshal(payload)
		return RequestSpec{Method: post, Path: path + "/comment", Body: body, JSON: true}, err
	case "timer":
		return RequestSpec{Method: post, Path: path + "/timer/" + command.Value}, nil
	case "complete", "renew":
		return RequestSpec{Method: post, Path: path + "/" + command.Kind}, nil
	case "create":
		body, err := io.ReadAll(stdin)
		if err != nil {
			return RequestSpec{}, &CommandError{Code: 1, Text: "Не удалось прочитать JSON из stdin."}
		}
		return RequestSpec{Method: post, Path: base + "/tasks", Body: body, JSON: true}, nil
	case "users":
		return RequestSpec{Method: get, Path: base + "/users?q=" + encodeQuery(command.Value)}, nil
	default:
		return RequestSpec{}, errors.New("Нет обработчика команды tracker.")
	}
}

type boardEntry struct {
	ID      string          `json:"id"`
	Name    *string         `json:"name"`
	Status  *string         `json:"status"`
	Default bool            `json:"default"`
	Reason  json.RawMessage `json:"reason"`
}

// boards выводит только включённые доски в порядке ответа каталога.
// Если каталог старой версии, используются прежние externalId и строковые умолчания.
func boards(ctx context.Context, connection Connection, send Sender) ([]byte, error) {
	body, err := send(ctx, connection, RequestSpec{Method: http.MethodGet, Path: "/api/trackers"})
	if err != nil {
		return nil, err
	}
	var catalog struct {
		EnabledIDs []string     `json:"enabledIds"`
		ExternalID string       `json:"externalId"`
		Default    *string      `json:"default"`
		Drivers    []boardEntry `json:"drivers"`
	}
	if err := json.Unmarshal(skipBOM(body), &catalog); err != nil {
		return nil, err
	}
	if catalog.EnabledIDs == nil && catalog.ExternalID != "" {
		catalog.EnabledIDs = []string{catalog.ExternalID}
	}
	defaultID := catalog.ExternalID
	if catalog.Default != nil {
		defaultID = *catalog.Default
	}

	unavailable := "unavailable"
	result := make([]boardEntry, 0, len(catalog.EnabledIDs))
	for _, id := range catalog.EnabledIDs {
		entry := boardEntry{ID: id, Name: &id, Status: &unavailable, Default: id == defaultID}
		for _, driver := range catalog.Drivers {
			if driver.ID != id {
				continue
			}
			if driver.Name != nil {
				entry.Name = driver.Name
			}
			if driver.Status != nil {
				entry.Status = driver.Status
			}
			entry.Reason = driver.Reason
			break
		}
		result = append(result, entry)
	}
	return jsonv2.Marshal(result)
}

// pipeline подтверждает источник адресной доски до оценки, чтения опций или постановки запуска.
// Явный источник stdin при этом может совпасть с подтверждённым, а без доски остаётся как был.
func pipeline(
	ctx context.Context, command Command, connection Connection, stdin io.Reader, send Sender,
) ([]byte, error) {
	var body launchObject
	if command.Kind == "launch" {
		var err error
		body, err = readLaunchBody(stdin)
		if err != nil {
			return nil, &CommandError{Code: 2, Text: "Запуск принимает JSON-объект из stdin."}
		}
	}
	var source string
	if command.Board != "" {
		var err error
		source, err = boardSource(ctx, command.Board, connection, send)
		if err != nil {
			return nil, err
		}
		if entry, exists := body.find("source"); exists && entry != source {
			return nil, &CommandError{Code: 2, Text: "Источник stdin противоречит --board."}
		}
		body.set("source", source)
	}

	path := "/api/tasks/" + encodeSegment(command.ID) + "/" + command.Kind
	if command.Kind == "launch-options" {
		if source != "" {
			path += "?source=" + encodeQuery(source)
		}
		return send(ctx, connection, RequestSpec{Method: http.MethodGet, Path: path})
	}

	payload, err := jsonv2.Marshal(body)
	if err != nil {
		return nil, err
	}
	return send(ctx, connection, RequestSpec{Method: http.MethodPost, Path: path, Body: payload, JSON: true})
}

// boardSource проверяет форму подтверждённого источника и соответствие целевой доске.
// При отказе команда завершается без запроса на доску по умолчанию.
func boardSource(ctx context.Context, board string, connection Connection, send Sender) (string, error) {
	spec := RequestSpec{Method: http.MethodGet, Path: trackerPath(board) + "/context"}
	body, err := send(ctx, connection, spec)
	if err != nil {
		return "", err
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(skipBOM(body), &result); err != nil {
		if !json.Valid(skipBOM(body)) {
			return "", &CommandError{Code: 22, Text: "Неверный ответ подключения доски."}
		}
	}
	var source string
	_ = json.Unmarshal(result["source"], &source)
	id, _, _ := strings.Cut(source, "@")
	if !sourcePattern.MatchString(source) || id != board {
		return "", &CommandError{Code: 22, Text: "Не удалось подтвердить источник доски."}
	}
	return source, nil
}

func skipBOM(body []byte) []byte {
	return bytes.TrimPrefix(body, []byte("\ufeff"))
}
