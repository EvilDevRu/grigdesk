package runner

import (
	"regexp"
	"slices"
	"strconv"
	"testing"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

func TestAttemptPrimaryTakesPrecedence(t *testing.T) {
	input := DispatchRequest{Stage: "SCOUT", Primary: "glm", Config: map[string]string{
		"STAGE_SCOUT_PRIMARY":     "codex",
		"STAGE_SCOUT_FAILOVER":    "claude",
		"PROJECT_RUNNER_PRIMARY":  "deepseek",
		"PROJECT_RUNNER_FAILOVER": "qwen",
	}}
	if got := input.ProviderChain(); !slices.Equal(got, []string{"glm"}) {
		t.Fatalf("config профиля подменил закреплённый выбор: %v", got)
	}
}

func TestDispatchPolicy(t *testing.T) {
	cases := []struct {
		name     string
		phase    string
		class    string
		started  bool
		switched bool
	}{
		{"preflight-unavailable", "preflight", "unavailable_preflight", false, true},
		{"route-unavailable", "preflight", "route_unavailable", false, true},
		{"started-limited", "started", "limited", true, true},
		{"started-provider", "started", "provider_unavailable", true, true},
		{"late-preflight", "preflight", "unavailable_preflight", true, false},
		{"unknown", "started", "unknown", true, false},
		{"transient", "started", "transient", true, false},
		{"context-overflow", "started", "context_overflow", true, false},
		{"denied", "started", "denied", true, false},
		{"invalid-config", "started", "invalid_config", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := policyAllowsSwitch(tc.phase, tc.class, tc.started); got != tc.switched {
				t.Fatalf("policyAllowsSwitch=%t, ожидалось %t", got, tc.switched)
			}
		})
	}
}

func TestRunEpoch(t *testing.T) {
	run := adapterFixture(t)
	first := run.Identity
	seq := first.Epoch + 3
	fields := []state.ProjectionField{{
		Key: "ACTIVE_EPOCH_" + first.Stage, Value: strconv.FormatUint(seq, 10),
	}}
	if err := run.Store.UpdateProjection(first.Task, first.Attempt, fields); err != nil {
		t.Fatal(err)
	}
	next, err := beginEpoch(run, first.Task, first.Attempt, first.Stage, "")
	if err != nil || next.Identity.Epoch != seq+1 ||
		!regexp.MustCompile(`^r[a-f0-9]{32}$`).MatchString(next.Identity.ID) ||
		next.Capability == run.Capability {
		t.Fatalf("новая эпоха=%+v ошибка=%v", next.Identity, err)
	}
	if rc, _ := run.Store.ApplyRunResult(first, run.Capability, "done", "", ""); rc != 73 {
		t.Fatalf("старое право вернуло %d", rc)
	}
	if rc, _ := run.Store.ApplyRunResult(next.Identity, run.Capability, "done", "", ""); rc != 74 {
		t.Fatalf("чужое право возращено с %d", rc)
	}
	for _, want := range []int{0, 75} {
		if rc, _ := run.Store.ApplyRunResult(next.Identity, next.Capability, "done", "", ""); rc != want {
			t.Fatalf("terminal rc=%d, ожидался %d", rc, want)
		}
	}
}

func TestAdapterContracts(t *testing.T) {
	t.Run("codex", TestCodexAdapterOffline)
	t.Run("deepseek-glm", TestDeepSeekGlmLaunch)
	t.Run("claude", TestClaudeAdapter)
	t.Run("kimi", TestKimiAdapter)
	t.Run("qwen", TestQwenAdapterArgs)
	t.Run("epoch", TestRunEpoch)
}
