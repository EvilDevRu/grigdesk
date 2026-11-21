package terminal

import (
	"io"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/term"
	"golang.org/x/text/width"
)

type Tone string

const (
	Text    Tone = "\x1b[22;38;2;224;229;237m"
	Accent  Tone = "\x1b[1;38;2;140;206;206m"
	Muted   Tone = "\x1b[22;38;2;154;165;181m"
	Rule    Tone = "\x1b[22;38;2;83;97;116m"
	Success Tone = "\x1b[22;38;2;142;203;167m"
	Warning Tone = "\x1b[22;38;2;226;190;121m"
	Error   Tone = "\x1b[22;38;2;239;144;144m"

	background = "\x1b[48;2;27;31;38m"
	highlight  = "\x1b[48;2;41;59;67m"
	reset      = "\x1b[0m"
)

type Span struct {
	Text string
	Tone Tone
}

type Row struct {
	Spans    []Span
	Selected bool
}

type Screen struct {
	out        io.Writer
	positioned bool
	color      bool
	open       bool
	hidden     bool
}

// IsTTY проверяет фактический поток вывода, включая запуск с перенаправлением.
// Обёртки и буферы получают обычный текстовый формат.
func IsTTY(stream any) bool {
	file, ok := stream.(*os.File)
	return ok && term.IsTerminal(int(file.Fd()))
}

// NewScreen выбирает возможности терминала один раз для всего экрана.
// NO_COLOR сохраняет позиционирование, TERM=dumb оставляет только текст.
func NewScreen(out io.Writer, env map[string]string) Screen {
	positioned := env["TERM"] != "dumb" && IsTTY(out)
	return Screen{out: out, positioned: positioned, color: positioned && env["NO_COLOR"] == ""}
}

func (screen Screen) Positioned() bool {
	return screen.positioned
}

// ShowCursor готовит открытый экран к обычному вводу или потоковому выводу.
// Следующий кадр снова скрывает курсор на время навигации.
func (screen *Screen) ShowCursor() {
	if screen.open && screen.hidden {
		_, _ = io.WriteString(screen.out, "\x1b[?25h")
		screen.hidden = false
	}
}

// Size возвращает физический размер окна и подставляет разумный размер для пустого PTY.
// Последний столбец оставлен свободным, чтобы терминал не переносил строки сам.
func Size(fd int) (int, int) {
	columns, rows, _ := term.GetSize(fd)
	if columns < 1 {
		columns = 80
	}
	if rows < 1 {
		rows = 24
	}
	return max(1, columns-1), rows
}

func Inset(columns int) string {
	if columns >= 34 {
		return "  "
	}
	return ""
}

func Line(text string, tone Tone) Row {
	return Row{Spans: []Span{{Text: text, Tone: tone}}}
}

// Label оформляет подпись для обычного терминального потока.
// Стиль заканчивается до следующего вывода или ввода текста.
func (screen Screen) Label(text string, tone Tone) string {
	text = Clean(text)
	if screen.color {
		return background + string(tone) + "  " + text + "  " + reset
	}
	return text
}

// Close возвращает видимый курсор и содержимое обычного терминала.
// Повторный вызов допустим между вложенными действиями и при выходе.
func (screen *Screen) Close() {
	if screen.open {
		screen.ShowCursor()
		_, _ = io.WriteString(screen.out, "\x1b[?1049l")
		screen.open = false
	}
}

// Draw выводит кадр одним обновлением с собственной подложкой и выделением.
// Управляющие байты создаёт только рендерер, текст обрезается до видимой ширины.
func (screen *Screen) Draw(lines []Row, columns, rows int) {
	var frame strings.Builder
	if screen.positioned {
		if !screen.open {
			frame.WriteString("\x1b[?1049h")
			screen.open = true
		}
		if !screen.hidden {
			frame.WriteString("\x1b[?25l")
			screen.hidden = true
		}
		frame.WriteString("\x1b[H")
	}
	for index, row := range lines {
		screen.paint(&frame, row, columns)
		if index+1 < rows || !screen.positioned {
			frame.WriteString("\r\n")
		}
	}
	if screen.positioned {
		if len(lines) < rows {
			frame.WriteString("\x1b[J")
		}
		if screen.color {
			frame.WriteString(reset)
		}
	}
	_, _ = io.WriteString(screen.out, frame.String())
}

// paint дополняет выбранную строку фоном до края списка.
// Остаток строки получает обычную подложку независимо от ширины выбранного текста.
func (screen Screen) paint(frame *strings.Builder, row Row, columns int) {
	remaining := columns
	if screen.color {
		frame.WriteString(background)
		if row.Selected {
			frame.WriteString(highlight)
		}
	}
	for _, span := range row.Spans {
		if remaining <= 0 {
			break
		}
		text := Fit(span.Text, remaining)
		if screen.color {
			tone := span.Tone
			if row.Selected {
				tone = Accent
			}
			if tone == "" {
				tone = Text
			}
			frame.WriteString(string(tone))
		}
		frame.WriteString(text)
		remaining -= Cells(text)
	}
	if screen.color {
		if row.Selected {
			frame.WriteString(strings.Repeat(" ", remaining))
		}
		frame.WriteString(background)
	}
	if screen.positioned {
		frame.WriteString("\x1b[K")
	}
}

// Option использует один маркер выбора во всех списках и подтверждениях.
// Стрелка справа отмечает переход на следующий уровень.
func Option(label string, columns int, selected, next bool) Row {
	inset := Inset(columns)
	prefix := inset + "  "
	if selected {
		prefix = inset + "› "
	}
	label = Fit(label, max(0, columns-Cells(prefix)-len(inset)-2))
	line := prefix + label
	if next && columns >= 8 {
		gap := columns - len(inset) - Cells(line) - 1
		line += strings.Repeat(" ", gap) + "›"
	}
	return Row{Spans: []Span{{Text: line, Tone: Text}}, Selected: selected}
}

// Clean выбрасывает управляющие символы из внешних данных до применения стиля.
// В результате произвольный текст не может отправить терминалу новую команду.
func Clean(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, text)
}

func cellWidth(r rune) int {
	switch width.LookupRune(r).Kind() {
	case width.EastAsianWide, width.EastAsianFullwidth:
		return 2
	}
	if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) {
		return 0
	}
	return 1
}

// Cells измеряет печатную ширину строки для выравнивания в TTY.
// Широкие локализованные символы занимают две ячейки, сочетания учитывают диакритику.
func Cells(text string) int {
	columns := 0
	for _, r := range text {
		columns += cellWidth(r)
	}
	return columns
}

func prefix(text string, columns int) string {
	for index, r := range text {
		columns -= cellWidth(r)
		if columns < 0 {
			return text[:index]
		}
	}
	return text
}

// Fit сокращает длинную строку до ширины выбранной области.
// Многоточие занимает отдельную ячейку и остаётся видимым в самом узком поле.
func Fit(text string, columns int) string {
	if columns <= 0 {
		return ""
	}
	text = Clean(text)
	if Cells(text) <= columns {
		return text
	}
	return prefix(text, columns-1) + "…"
}

// Wrap переносит описание и подробности по словам.
// Неразрывные длинные слова делятся по доступным терминальным ячейкам.
func Wrap(text string, columns int) []string {
	var lines []string
	text = Clean(text)
	for Cells(text) > columns {
		part := prefix(text, columns)
		if part == "" {
			_, size := utf8.DecodeRuneInString(text)
			part = text[:size]
		}
		if space := strings.LastIndexByte(part, ' '); space > 0 {
			part = part[:space]
		}
		lines = append(lines, Fit(part, columns))
		text = strings.TrimLeft(text[len(part):], " ")
	}
	return append(lines, text)
}
