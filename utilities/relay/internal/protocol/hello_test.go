package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

// TestHello сохраняет приоритет кодов для известных версий, целей и ролей.
// Фикстура содержит только подставные значения и не открывает сеть.
func TestHello(t *testing.T) {
	data, err := os.ReadFile("../../testdata/hello.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Line  json.RawMessage `json:"line"`
		Role  string          `json:"role"`
		Error string          `json:"error"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, test := range cases {
		parsed, err := ParseHello(test.Line)
		if test.Error != "" {
			if err == nil || err.Error() != test.Error {
				t.Errorf("строка %s: ожидали %s, получили %v", test.Line, test.Error, err)
			}
		} else if err != nil || parsed.Role != test.Role {
			t.Errorf("строка %s: получили %v, %v", test.Line, parsed, err)
		}
	}
}

// TestReadLine проверяет точный предел UTF-8 и сохранение бинарного хвоста в reader.
// Некорректная кодировка не доходит до JSON или сокета назначения.
func TestReadLine(t *testing.T) {
	wire := append([]byte("Привет\n"), 22, 3, 3, 0, 255)
	reader := bufio.NewReaderSize(bytes.NewReader(wire), Maximum+1)
	line, err := ReadLine(reader)
	if err != nil || string(line) != "Привет" {
		t.Fatalf("строка %q, %v", line, err)
	}
	rest, err := io.ReadAll(reader)
	if err != nil || !bytes.Equal(rest, []byte{22, 3, 3, 0, 255}) {
		t.Fatalf("потерян хвост %v, %v", rest, err)
	}
	for _, input := range []string{"\xff\n", strings.Repeat("a", Maximum+1) + "\n"} {
		r := bufio.NewReaderSize(strings.NewReader(input), Maximum+1)
		if _, err := ReadLine(r); err == nil || errors.Is(err, io.EOF) || err.Error() != "bad_hello" {
			t.Fatalf("ожидался bad_hello, получено %v", err)
		}
	}
}
