package voicecore

import (
	"context"
	"crypto/rand"
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"

	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
)

type Failure struct {
	Code int
	Text string
}

func (err *Failure) Error() string {
	return err.Text
}

func Usage(text string) error {
	return &Failure{Code: 2, Text: text}
}

func Failed(text string) error {
	return &Failure{Code: 1, Text: text}
}

type Capabilities struct {
	Languages   []string `json:"languages"`
	Pace        bool     `json:"pace"`
	Stress      bool     `json:"stress"`
	StressMode  string   `json:"stressMode,omitempty"`
	Instruction bool     `json:"instruction,omitzero"`
	Pause       bool     `json:"pause"`
	Tone        bool     `json:"tone"`
	Emphasis    bool     `json:"emphasis"`
	MaxChars    int      `json:"maxChars"`
	Formats     []string `json:"formats"`
}

type Metadata struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Model   string `json:"model"`
	Service string `json:"service,omitempty"`
	Default string `json:"-"`
}

type Doctor struct {
	Status  string `json:"status"`
	Reason  string `json:"reason"`
	Install string `json:"install"`
}

type Voice struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Languages []string `json:"languages"`
	Timbre    string   `json:"timbre,omitempty"`
	Styles    []string `json:"styles,omitempty"`
	Available bool     `json:"available"`
	Reason    string   `json:"reason"`
}

type Input struct {
	Text        string
	Voice       string
	Language    string
	File        string
	Format      string
	Pace        string
	Instruction string
}

type Result struct {
	File     string
	Bytes    int64
	Ignored  []string
	Warnings []string
}

type Engine interface {
	Meta() Metadata
	Capabilities() Capabilities
	Doctor(context.Context) (Doctor, error)
	Voices(context.Context) ([]Voice, error)
	Synthesize(context.Context, Input) (Result, error)
}

type Prepared struct {
	Text   []rune
	Stress []int
}

var Paces = []string{"slowest", "slow", "normal", "fast", "fastest"}

// Prepare применяет исходные ограничения движка к каноническому тексту.
// Формат, язык и темп проверяются до вызова Python или HTTP.
func Prepare(ctx context.Context, input Input, caps Capabilities) (Prepared, error) {
	if ctx.Err() != nil {
		return Prepared{}, Failed("Операция отменена.")
	}
	if input.Format != "wav" || !slices.Contains(caps.Formats, "wav") {
		return Prepared{}, Usage("Неподдержанный формат: в v1 доступен только wav.")
	}
	if input.Pace != "" && !slices.Contains(Paces, input.Pace) {
		return Prepared{}, Usage("Неизвестный темп речи.")
	}
	if input.Language != "" && !slices.Contains(caps.Languages, input.Language) {
		return Prepared{}, Usage("Выбранный движок не поддерживает указанный язык.")
	}
	parsed := ParseText(input.Text)
	if len(parsed.Text) == 0 {
		return Prepared{}, Usage("Пустой текст для синтеза.")
	}
	if len(utf16.Encode(parsed.Text)) > caps.MaxChars {
		message := fmt.Sprintf("Реплика длиннее предела движка: максимум %d символов.", caps.MaxChars)
		return Prepared{}, Usage(message)
	}
	return parsed, nil
}

// ParseText схлопывает пробелы и запоминает позиции гласных после значимых плюсов.
// Арифметика и знаки вне кириллического слова остаются обычным текстом.
func ParseText(text string) Prepared {
	var result Prepared
	chars := []rune(text)
	for i, char := range chars {
		if char == '+' && i+1 < len(chars) && strings.ContainsRune("аеёиоуыэюяАЕЁИОУЫЭЮЯ", chars[i+1]) &&
			(i == 0 || isCyrillic(chars[i-1]) || !unicode.IsLetter(chars[i-1]) && !unicode.IsNumber(chars[i-1])) {
			result.Stress = append(result.Stress, len(result.Text))
			continue
		}
		if localapi.TrimSpace(string(char)) == "" {
			if n := len(result.Text); n != 0 && result.Text[n-1] != ' ' {
				result.Text = append(result.Text, ' ')
			}
			continue
		}
		result.Text = append(result.Text, char)
	}
	if n := len(result.Text); n != 0 && result.Text[n-1] == ' ' {
		result.Text = result.Text[:n-1]
	}
	return result
}

func isCyrillic(r rune) bool {
	return r == 'ё' || r == 'Ё' || r >= 'А' && r <= 'я'
}

// Language выбирает русский, китайский или английский по скрипту текста.
// При смешанном тексте порядок остаётся таким же, как в общем парсере реплик.
func Language(text []rune) string {
	if slices.ContainsFunc(text, isCyrillic) {
		return "ru"
	}
	if slices.ContainsFunc(text, func(r rune) bool { return unicode.Is(unicode.Han, r) }) {
		return "zh"
	}
	if slices.ContainsFunc(text, func(r rune) bool { return unicode.Is(unicode.Latin, r) }) {
		return "en"
	}
	return ""
}

// Ignored перечисляет только явные указания, которые выбранный движок не применил.
// Поле всегда представляет массив, даже когда все указания были обработаны.
func Ignored(input Input, parsed Prepared, caps Capabilities) []string {
	out := make([]string, 0, 3)
	if input.Pace != "" && input.Pace != "normal" && !caps.Pace {
		out = append(out, "темп")
	}
	if len(parsed.Stress) > 0 && !caps.Stress {
		out = append(out, "ударения")
	}
	if localapi.TrimSpace(input.Instruction) != "" && !caps.Instruction {
		out = append(out, "инструкция")
	}
	return out
}

// UUID выдаёт уникальное имя цели и отдельной generation в форме RFC 4122 v4.
// Системный источник энтропии общий для всех создаваемых временных объектов.
func UUID() string {
	var id [16]byte
	_, _ = rand.Read(id[:])
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}
