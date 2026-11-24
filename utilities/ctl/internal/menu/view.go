package menu

import (
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/ctl/internal/terminal"
)

// layout собирает меню с шапкой, списком и подсказкой выбранного пункта.
// Сначала убираются пустые строки, затем список прокручивается за выбором.
func (ui *session) layout(
	title string, items []item, selected int, root bool, columns, rows int,
) []terminal.Row {
	inset := terminal.Inset(columns)
	content := columns - len(inset)*2
	header := ui.headerRows(content, inset)
	if !root {
		header = append(header, terminal.Line(inset+ui.lang.Text(title), terminal.Accent))
	}
	list, active := ui.itemRows(items, selected, root, columns)
	navigation := ui.lang.Text("navigation")
	compact := ui.lang.Text("compactNavigation")
	if root {
		navigation = ui.lang.Text("rootNavigation")
		compact = ui.lang.Text("compactRootNavigation")
	}
	if terminal.Cells(navigation) > content {
		navigation = compact
	}
	if terminal.Cells(navigation) > content {
		navigation = "↑↓ · Enter · Esc"
	}
	footer := terminal.Line(inset+terminal.Fit(navigation, content), terminal.Muted)
	rule := terminal.Line(inset+strings.Repeat("─", content), terminal.Rule)
	lines := append([]terminal.Row{{}}, header...)
	lines = append(lines, rule, terminal.Row{})
	lines = append(lines, list...)
	lines = append(lines, terminal.Row{})
	lines = append(lines, ui.descriptionRows(items[selected], content, inset)...)
	lines = append(lines, rule, footer)

	limit := max(1, rows-1)
	if len(lines) <= limit {
		return lines
	}
	lines = slices.DeleteFunc(lines, blank)
	if len(lines) <= limit {
		return lines
	}
	return compactRows(header, list, active, footer, limit)
}

func blank(row terminal.Row) bool {
	return len(row.Spans) == 0
}

// compactRows оставляет место для выбранного пункта и навигации.
// При малой высоте рядом с выбором показывается столько соседних пунктов, сколько вмещается.
func compactRows(header, list []terminal.Row, active int, footer terminal.Row, limit int) []terminal.Row {
	if limit == 1 {
		return list[active : active+1]
	}
	body := slices.DeleteFunc(list, blank)
	active = slices.IndexFunc(body, func(row terminal.Row) bool { return row.Selected })
	head := min(len(header), max(0, limit-4))
	count := min(len(body), limit-head-1)
	start := terminal.Window(active, len(body), count)
	rows := append(slices.Clone(header[:head]), body[start:start+count]...)
	return append(rows, footer)
}

// headerRows ставит вид поставки справа и собирает короткую строку состояний.
// В узком окне каждый статус получает отдельную строку или переносится по словам.
func (ui *session) headerRows(columns int, inset string) []terminal.Row {
	brand := strings.TrimSpace("GrigDesk " + ui.header.version)
	mode := ui.lang.Text(ui.header.mode)
	gap := columns - terminal.Cells(brand) - terminal.Cells(mode)
	brandRow := terminal.Line(inset+terminal.Fit(brand, columns), terminal.Accent)
	var rows []terminal.Row
	if gap >= 2 {
		brandRow.Spans = append(brandRow.Spans, terminal.Span{
			Text: strings.Repeat(" ", gap) + mode, Tone: terminal.Muted,
		})
		rows = append(rows, brandRow)
	} else {
		rows = append(rows, brandRow, terminal.Line(inset+terminal.Fit(mode, columns), terminal.Muted))
	}
	server := ui.status("menuServerState", ui.header.server)
	window := ui.status("menuWindowState", ui.header.window)
	if terminal.Cells(server.Text)+terminal.Cells(window.Text)+3 <= columns {
		return append(rows, terminal.Row{Spans: []terminal.Span{
			{Text: inset}, server, {Text: "   "}, window,
		}})
	}
	for _, span := range []terminal.Span{server, window} {
		for _, line := range terminal.Wrap(span.Text, columns) {
			rows = append(rows, terminal.Line(inset+line, span.Tone))
		}
	}
	return rows
}

// status дублирует смысл цвета знаком и локализованным текстом.
// Для нового состояния без перевода используется общее «неизвестно».
func (ui *session) status(label, state string) terminal.Span {
	marker, tone := "○", terminal.Muted
	switch state {
	case "ready", "open":
		marker, tone = "●", terminal.Success
	case "failed", "conflict", "mismatch", "not_responding":
		marker, tone = "✗", terminal.Error
	case "starting", "stopping", "unknown":
		tone = terminal.Warning
	}
	key := "states." + state
	text := ui.lang.Text(key)
	if label == "menuWindowState" && state == "not_installed" {
		text = ui.lang.Text("screens.windowMissing")
	} else if text == key {
		text, tone = ui.lang.Text("states.unknown"), terminal.Warning
	}
	formatted := strings.NewReplacer("{marker}", marker, "{state}", text).Replace(ui.lang.Text(label))
	return terminal.Span{Text: formatted, Tone: tone}
}

// itemRows группирует реальные команды по назначению, независимо от режима поставки.
// Выход расположен отдельно и не наследует заголовок соседней группы.
func (ui *session) itemRows(items []item, selected int, root bool, columns int) ([]terminal.Row, int) {
	inset := terminal.Inset(columns)
	var rows []terminal.Row
	group, active := "", 0
	for index, value := range items {
		if root {
			if section := itemGroup(value.label); section != group {
				if group != "" {
					rows = append(rows, terminal.Row{})
				}
				if section != "" {
					rows = append(rows, terminal.Line(inset+ui.lang.Text("menuGroups."+section), terminal.Muted))
				}
				group = section
			}
		}
		if index == selected {
			active = len(rows)
		}
		label := ui.lang.Text(value.label)
		if value.disabled {
			label += " · " + ui.lang.Text("distribution.unavailable")
		}
		line := terminal.Option(label, columns, index == selected, len(value.children) != 0)
		if value.disabled {
			line.Spans[0].Tone = terminal.Muted
		}
		rows = append(rows, line)
	}
	return rows, active
}

func itemGroup(label string) string {
	switch label {
	case "build", "development", "artifactsCleanup", "dist":
		return "developer"
	case "exit":
		return ""
	default:
		return "application"
	}
}

// descriptionRows переносит подсказку только для текущего пункта.
// Пункты без описания не получают техническое имя ключа вместо текста.
func (ui *session) descriptionRows(selection item, columns int, inset string) []terminal.Row {
	key := selection.desc
	if selection.disabled {
		key = "distribution.unavailableDescription"
	} else if key == "" {
		key = selection.label + "Description"
	}
	text := ui.lang.Text(key)
	if text == key {
		return nil
	}
	var rows []terminal.Row
	for _, line := range terminal.Wrap(text, columns) {
		rows = append(rows, terminal.Line(inset+line, terminal.Muted))
	}
	return rows
}
