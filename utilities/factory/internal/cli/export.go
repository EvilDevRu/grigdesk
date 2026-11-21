package cli

import (
	"encoding/json"
	"io"

	"grigdesk.local/tools/utilities/factory/internal/engine"
)

// exportFindings сохраняет два формата короткого CLI с точным attempt pin.
func exportFindings(r request, out, diagnostic io.Writer) int {
	value, err := engine.ExportFindings(makeLaunchRequest(r, diagnostic))
	if err != nil {
		return fail(diagnostic, err)
	}
	if r.value("--format") == "markdown" {
		if _, err := io.WriteString(out, value.Markdown()); err != nil {
			return 1
		}
		return 0
	}
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value.JSON()); err != nil {
		return 1
	}
	return 0
}
