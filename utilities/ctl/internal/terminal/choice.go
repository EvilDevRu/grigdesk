package terminal

import (
	"strings"
)

type Choice struct {
	Title      string
	Details    []string
	Options    []string
	Navigation string
	Paging     string
	Current    int
	Shortcut   func(byte) (int, error)
}

type ChooseFunc func(Choice) (int, error)

// Choose показывает вопрос, подробности и строки выбора на общем экране.
// Общий экран меню остаётся у его владельца после окончания выбора.
func (screen *Screen) Choose(input Input, choice Choice) (int, error) {
	if screen.open {
		defer screen.ShowCursor()
	} else {
		defer screen.Close()
	}

	return input.Select(Selection{
		Count: len(choice.Options), Current: choice.Current, Shortcut: choice.Shortcut,
		Draw: func(columns, rows, selected, page int) int {
			columns = min(columns, 80)
			lines, page := choice.layout(columns, rows, selected, page)
			screen.Draw(lines, columns, rows)
			return page
		},
	})
}

// Window держит выбранную строку в области просмотра с минимальным сдвигом.
// На высоком экране список начинается с первой строки.
func Window(selected, count, size int) int {
	return min(max(0, selected-size+1), max(0, count-size))
}

// layout размещает управление и варианты после видимой части отчёта.
// Прокрутка отчёта не меняет активный пункт даже в низком терминале.
func (choice Choice) layout(columns, rows, selected, page int) ([]Row, int) {
	inset := Inset(columns)
	content := columns - len(inset)*2
	if rows == 1 {
		return []Row{Option(choice.Options[selected], columns, true, false)}, 0
	}
	limit := max(1, rows-1)
	title := Wrap(choice.Title, content)
	lines := make([]Row, 0, limit)
	for _, text := range title[:min(len(title), max(1, limit-2))] {
		lines = append(lines, Line(inset+text, Accent))
	}
	visibleOptions := min(len(choice.Options), max(1, limit-2))
	visibleOptions = min(visibleOptions, max(1, limit-len(lines)-1))
	remaining := max(0, limit-len(lines)-visibleOptions-1)
	var detail []Row
	for _, part := range choice.Details {
		for _, text := range Wrap(part, content) {
			detail = append(detail, Line(inset+text, Muted))
		}
	}
	if remaining > 0 && len(detail) > 0 {
		lastPage := (len(detail) - 1) / remaining
		page = min(page, lastPage)
		start := page * remaining
		lines = append(lines, detail[start:min(start+remaining, len(detail))]...)
	} else {
		page = 0
	}
	from := Window(selected, len(choice.Options), visibleOptions)
	for index := from; index < from+visibleOptions; index++ {
		lines = append(lines, Option(choice.Options[index], columns, index == selected, false))
	}
	if len(lines) < limit {
		navigation := choice.Navigation
		if len(detail) > remaining && choice.Paging != "" {
			navigation = choice.Paging
		}
		lines = append(lines, Line(inset+strings.TrimSpace(navigation), Muted))
	}
	return lines, page
}
