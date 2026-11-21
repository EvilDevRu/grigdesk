package cli

import (
	"io"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

// readLifecycle сначала подтверждает весь журнал точной попытки через Store.
// При неполном хвосте вызывающий сервер не получает частичного доказательства.
func readLifecycle(r request, out, diagnostic io.Writer) int {
	store := state.Store{ControlDir: r.value("--control-dir")}
	events, err := store.ReadLifecycle(r.task, r.value("--attempt"))
	if err != nil {
		return fail(diagnostic, err)
	}
	for _, event := range events {
		if _, err := out.Write(event.Line); err != nil {
			return fail(diagnostic, err)
		}
	}
	return 0
}
