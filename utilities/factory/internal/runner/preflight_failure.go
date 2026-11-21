package runner

import (
	"slices"
	"strings"
)

// preflightFailureMarker сохраняет тип отказа, по которому сервер может один раз
// повторить resume. Для этого несовместимость должна объяснять каждый отказ.
func preflightFailureMarker(rc int, unavailable []string, incompatible map[string]bool) string {
	if rc == 0 {
		return ""
	}
	if rc != 1 || len(unavailable) == 0 {
		return "[FACTORY_ERROR=runner_preflight_failed]"
	}
	kind := "runner_preflight_incompatible"
	for _, name := range unavailable {
		if !incompatible[name] {
			kind = "runner_preflight_unavailable"
			break
		}
	}
	names := slices.Clone(unavailable)
	slices.Sort(names)
	names = slices.Compact(names)
	return "[FACTORY_ERROR=" + kind + " RUNNERS=" + strings.Join(names, ",") + "]"
}
