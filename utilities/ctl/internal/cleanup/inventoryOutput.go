package cleanup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/term"

	"grigdesk.local/tools/shared/i18n"
	"grigdesk.local/tools/utilities/ctl/internal/service"
)

const textInventoryLimit = 20

// runInventory сохраняет отдельный контракт отчёта и коды завершения уборки.
// Сообщение о начале идёт только в терминал, поэтому JSON остаётся одним документом.
func runInventory(ctx context.Context, root string, rules options, lang i18n.CLI,
	terminal service.Terminal) int {
	if stream, ok := terminal.Stderr.(*os.File); ok && term.IsTerminal(int(stream.Fd())) {
		_, _ = fmt.Fprintln(stream, lang.Text("inventory.scanning"))
	}
	report, err := scanInventory(ctx, root, rules.topic)
	if err != nil {
		message := strings.ReplaceAll(lang.Text("inventory.openError"), "{error}", err.Error())
		return terminal.Fail(message, 1)
	}
	if rules.json {
		encoder := json.NewEncoder(terminal.Stdout)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(report); err != nil {
			return terminal.Fail(err.Error(), 1)
		}
	} else {
		showInventory(report, lang, terminal)
	}
	if report.Interrupted {
		return 130
	}
	if report.ErrorCount > 0 {
		return 1
	}
	return 0
}

// showInventory печатает итог, категории и до двадцати строк из самого большого в меньший.
// Размеры включают частично прочитанные ветки, поэтому ошибки явно показаны у строк и итога.
func showInventory(report inventoryReport, lang i18n.CLI, terminal service.Terminal) {
	scope := service.Printable(filepath.Join(report.Root, report.Topic))
	terminal.Say(strings.ReplaceAll(lang.Text("cleanup.root"), "{path}", scope))
	total := formatInventorySize(report.TotalBytes, lang)
	terminal.Say(strings.ReplaceAll(lang.Text("inventory.total"), "{size}", total))
	if len(report.Groups) > 0 {
		terminal.Say(lang.Text("inventory.groupHeading"))
		for _, group := range report.Groups {
			kind := lang.Text("inventory.kinds." + group.Kind)
			terminal.Say("  " + formatInventorySize(group.Bytes, lang) + "  " + kind)
		}
		terminal.Say(lang.Text("inventory.entryHeading"))
		for _, row := range report.Entries[:min(textInventoryLimit, len(report.Entries))] {
			label := service.Printable(row.Path)
			kind := lang.Text("inventory.kinds." + row.Kind)
			line := "  " + formatInventorySize(row.Bytes, lang) + "  " + label + "  [" + kind + "]"
			if row.ErrorCount > 0 {
				line += "  " + lang.Text("inventory.partial")
			}
			terminal.Say(line)
		}
	}
	if rest := len(report.Entries) - textInventoryLimit; rest > 0 {
		terminal.Say(strings.ReplaceAll(lang.Text("inventory.more"), "{count}", strconv.Itoa(rest)))
	}
	if report.ErrorCount > 0 {
		terminal.Say(strings.ReplaceAll(lang.Text("inventory.errors"), "{count}", strconv.Itoa(report.ErrorCount)))
	}
	if report.Interrupted {
		terminal.Say(lang.Text("inventory.interrupted"))
	}
}

// formatInventorySize показывает двоичные единицы, чтобы объём был сопоставим с du -h.
// Точные байты остаются в машиночитаемом отчёте.
func formatInventorySize(bytes int64, lang i18n.CLI) string {
	if bytes < 1024 {
		return strconv.FormatInt(bytes, 10) + " " + lang.Text("inventory.units.bytes")
	}
	size := float64(bytes) / 1024
	units := []string{"kib", "mib", "gib", "tib"}
	unit := 0
	for size >= 1024 && unit < len(units)-1 {
		size /= 1024
		unit++
	}
	return fmt.Sprintf("%.1f %s", size, lang.Text("inventory.units."+units[unit]))
}
