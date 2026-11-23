package graphworkflow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// InputSnapshot — неизменяемый манифест входов и рабочие записи со ссылками.
type InputSnapshot struct {
	Manifest []InputFile
	Rows     []Row
}

// TranscriptSegment — исходный элемент JSON-расшифровки с порядковым адресом.
type TranscriptSegment struct {
	Line   int    `json:"line"`
	TimeMs int64  `json:"timeMs"`
	Text   string `json:"text"`
}

const (
	maxInputFiles      = 20
	maxInputFileBytes  = 64 * 1024
	maxInputTotalBytes = 256 * 1024
	maxSafeInteger     = float64(9007199254740991)
)

type transcriptReplica struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

// NormalizeInputs проверяет счётчики, байты и имена, затем строит рабочие записи.
// Манифест сохраняет нормализованный текст до разбиения, включая пустые реплики.
func NormalizeInputs(kind string, files []InputFile) (InputSnapshot, error) {
	var snapshot InputSnapshot
	if kind != "documents" && kind != "transcript" {
		return snapshot, fmt.Errorf("inputKind: неизвестный вид входа")
	}
	if len(files) == 0 || len(files) > maxInputFiles {
		return snapshot, fmt.Errorf("files: от 1 до 20 входов")
	}
	if kind == "transcript" && len(files) != 1 {
		return snapshot, fmt.Errorf("files: расшифровка принимает один файл")
	}
	total := 0
	normalized := make([]InputFile, 0, len(files))
	for _, file := range files {
		if err := validateInputName(file.Name, kind); err != nil {
			return snapshot, err
		}
		if len(file.Text) > maxInputFileBytes {
			return snapshot, fmt.Errorf("files: вход превысил 64 КиБ")
		}
		total += len(file.Text)
		if total > maxInputTotalBytes {
			return snapshot, fmt.Errorf("files: суммарный объём превысил 256 КиБ")
		}
		if !utf8.ValidString(file.Text) || strings.ContainsRune(file.Text, 0) {
			return snapshot, fmt.Errorf("files: требуется UTF-8 без NUL")
		}
		normalized = append(normalized, InputFile{Name: file.Name, Text: strings.ReplaceAll(file.Text, "\r\n", "\n")})
	}
	snapshot.Manifest = normalized
	rows := make([]Row, 0)
	for index, file := range normalized {
		key := fmt.Sprintf("file-%d", index+1)
		if kind == "documents" {
			rows = append(rows, Row{
				Key: key, Title: file.Name, Text: file.Text,
				Sources: []SourceRef{{InputKey: key, Line: 1}},
			})
			continue
		}
		if strings.EqualFold(filepath.Ext(file.Name), ".json") {
			replicas, err := decodeTranscript(file.Text)
			if err != nil {
				return snapshot, err
			}
			for position, replica := range replicas {
				line := position + 1
				timeMs := int64(math.Round(replica.Start * 1000))
				if strings.TrimSpace(replica.Text) == "" {
					continue
				}
				millis := timeMs
				rows = append(rows, Row{
					Key: fmt.Sprintf("row-%d", line), Title: file.Name, Text: replica.Text,
					Sources: []SourceRef{{InputKey: key, Line: line, TimeMs: &millis}},
				})
			}
			continue
		}
		for number, line := range strings.Split(file.Text, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			rows = append(rows, Row{
				Key: fmt.Sprintf("row-%d", number+1), Title: file.Name, Text: line,
				Sources: []SourceRef{{InputKey: key, Line: number + 1}},
			})
		}
	}
	snapshot.Rows = rows
	return snapshot, nil
}

// validateInputName допускает один компонент с разрешённым расширением.
// Пути, управляющие символы и имена без расширения отвергаются до чтения.
func validateInputName(name, kind string) error {
	if name == "" || name == "." || name == ".." || utf8.RuneCountInString(name) > 120 ||
		strings.ContainsAny(name, "/\\") || strings.ContainsFunc(name, func(symbol rune) bool {
		return symbol < 0x20
	}) {
		return fmt.Errorf("name: недопустимое имя файла")
	}
	extension := strings.ToLower(filepath.Ext(name))
	switch kind {
	case "documents":
		if extension != ".txt" && extension != ".md" {
			return fmt.Errorf("name: документы принимают TXT/MD")
		}
	default:
		if extension != ".txt" && extension != ".json" {
			return fmt.Errorf("name: расшифровка принимает TXT/JSON")
		}
	}
	return nil
}

// decodeTranscript читает закрытый массив реплик и проверяет время и порядок.
// Метка элемента назначается до пропуска пустых реплик и не меняется.
func decodeTranscript(text string) ([]transcriptReplica, error) {
	var replicas []transcriptReplica
	decoder := json.NewDecoder(bytes.NewReader([]byte(text)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&replicas); err != nil {
		return nil, fmt.Errorf("transcript: неверный JSON расшифровки")
	}
	previous := float64(0)
	for index, replica := range replicas {
		if math.IsNaN(replica.Start) || math.IsInf(replica.Start, 0) ||
			math.IsNaN(replica.End) || math.IsInf(replica.End, 0) ||
			replica.Start < 0 || replica.End < replica.Start {
			return nil, fmt.Errorf("transcript: неверное время реплики %d", index+1)
		}
		if index > 0 && replica.Start < previous {
			return nil, fmt.Errorf("transcript: реплики должны идти по start")
		}
		if math.Round(replica.Start*1000) > maxSafeInteger {
			return nil, fmt.Errorf("transcript: время вне точного диапазона")
		}
		previous = replica.Start
	}
	return replicas, nil
}

// TranscriptSegments восстанавливает исходные метки JSON из сохранённых байтов.
// Пустые реплики сохраняют свой порядковый номер и таймкод для GET input.
func TranscriptSegments(text string) ([]TranscriptSegment, error) {
	replicas, err := decodeTranscript(text)
	if err != nil {
		return nil, err
	}
	segments := make([]TranscriptSegment, 0, len(replicas))
	for position, replica := range replicas {
		segments = append(segments, TranscriptSegment{
			Line: position + 1, TimeMs: int64(math.Round(replica.Start * 1000)), Text: replica.Text,
		})
	}
	return segments, nil
}
