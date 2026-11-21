package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const Maximum = 2048

type Hello struct {
	V            int
	Target       string
	Role         string
	Token        string
	ID           string
	Capabilities []string
	Proof        json.RawMessage
}

type Reply struct {
	OK           bool            `json:"ok"`
	Error        string          `json:"error,omitempty"`
	Capabilities []string        `json:"capabilities,omitempty"`
	Proof        json.RawMessage `json:"deploymentProof,omitempty"`
}

var connectionID = regexp.MustCompile(`^[a-f0-9]{32}$`)

// ReadLine читает один ограниченный кадр и оставляет reader у начала следующего байта.
// За newline могут идти кадры управления или бинарный вложенный TLS.
func ReadLine(reader *bufio.Reader) ([]byte, error) {
	data, err := reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) || len(data) > Maximum+1 {
		return nil, errors.New("bad_hello")
	}
	if err != nil {
		return nil, err
	}
	line := bytes.TrimPrefix(data[:len(data)-1], []byte("\ufeff"))
	if !utf8.Valid(line) {
		return nil, errors.New("bad_hello")
	}
	return line, nil
}

// ParseHello принимает только известные версии, роли и согласованную цель.
// Дополнительные поля не дают неописанной роли доступ к пересылке байтов.
func ParseHello(line []byte) (Hello, error) {
	var values map[string]json.RawMessage
	if json.Unmarshal(line, &values) != nil || values == nil {
		return Hello{}, errors.New("bad_hello")
	}
	var version float64
	_ = json.Unmarshal(values["v"], &version)
	role, _ := text(values["role"])
	target, _ := text(values["target"])
	if version != 1 && (version != 2 || target != "client" || role != "device" && role != "brain-data") {
		return Hello{}, errors.New("bad_version")
	}
	switch role {
	case "brain-control", "brain-data", "device", "health":
	default:
		return Hello{}, errors.New("bad_role")
	}
	if _, exists := values["target"]; version == 1 && exists {
		return Hello{}, errors.New("bad_hello")
	}
	token, tokenOK := text(values["token"])
	if role != "health" && (!tokenOK || len(utf16.Encode([]rune(token))) > 512) {
		return Hello{}, errors.New("bad_hello")
	}
	id, _ := text(values["id"])
	if role == "brain-data" && !connectionID.MatchString(id) {
		return Hello{}, errors.New("bad_hello")
	}
	caps, err := capabilities(values["capabilities"])
	if err != nil {
		return Hello{}, err
	}
	return Hello{
		V:            int(version),
		Target:       target,
		Role:         role,
		Token:        token,
		ID:           id,
		Capabilities: caps,
		Proof:        values["deploymentProof"],
	}, nil
}

// capabilities различает отсутствующий список и переданный элемент неподходящего типа.
// Содержимое списка проверяется независимо от роли клиента.
func capabilities(raw json.RawMessage) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil || list == nil {
		return nil, errors.New("bad_hello")
	}
	values := make([]string, 0, len(list))
	for _, element := range list {
		value, ok := text(element)
		if !ok {
			return nil, errors.New("bad_hello")
		}
		values = append(values, value)
	}
	return values, nil
}

func text(raw json.RawMessage) (string, bool) {
	var value string
	if !strings.HasPrefix(string(raw), "\"") || json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

// Write кадрирует ответ одним LF, сохраняя формат внешнего протокола.
// Сервер вызывает функцию под блокировкой только отдельного писателя.
func Write(writer io.Writer, value any) error {
	return json.NewEncoder(writer).Encode(value)
}
