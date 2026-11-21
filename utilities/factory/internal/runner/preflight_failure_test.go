package runner

import "testing"

func TestPreflightFailureMarker(t *testing.T) {
	incompatible := map[string]bool{"glm": true, "qwen": true}
	cases := []struct {
		name        string
		rc          int
		unavailable []string
		want        string
	}{
		{"ok", 0, nil, ""},
		{"all", 1, []string{"glm", "qwen"}, "[FACTORY_ERROR=runner_preflight_incompatible RUNNERS=glm,qwen]"},
		{"reordered", 1, []string{"qwen", "glm", "qwen"},
			"[FACTORY_ERROR=runner_preflight_incompatible RUNNERS=glm,qwen]"},
		{"mixed", 1, []string{"claude", "glm"},
			"[FACTORY_ERROR=runner_preflight_unavailable RUNNERS=claude,glm]"},
		{"ordinary", 1, []string{"codex"}, "[FACTORY_ERROR=runner_preflight_unavailable RUNNERS=codex]"},
		{"missing-report", 1, nil, "[FACTORY_ERROR=runner_preflight_failed]"},
		{"storage", 74, []string{"glm"}, "[FACTORY_ERROR=runner_preflight_failed]"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := preflightFailureMarker(tc.rc, tc.unavailable, incompatible)
			if got != tc.want {
				t.Errorf("маркер %q, требуется %q", got, tc.want)
			}
		})
	}
}
