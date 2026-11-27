package runner

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
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

// TestFactorySpeedInheritance проверяет порядок профильных ключей.
// Резерв и провайдер без режимов не получают чужую скорость.
func TestFactorySpeedInheritance(t *testing.T) {
	req := DispatchRequest{Stage: "REVIEW", Config: map[string]string{
		"MODEL_DEFAULT_CODEX_SPEED":  "fast",
		"MODEL_REVIEW_CODEX_SPEED":   "standard",
		"MODEL_DEFAULT_CLAUDE_SPEED": "",
		"MODEL_DEFAULT_GLM_SPEED":    "fast",
	}}
	if got := req.InheritedSpeed("codex"); got != "standard" {
		t.Fatalf("роль не перекрыла default: %q", got)
	}
	req.Stage = "PLAN"
	if got := req.InheritedSpeed("codex"); got != "fast" {
		t.Fatalf("соседняя роль не получила default: %q", got)
	}
	if got := req.InheritedSpeed("claude"); got != "" {
		t.Fatalf("скорость основного провайдера попала в резерв: %q", got)
	}
	if got := req.InheritedSpeed("glm"); got != "" {
		t.Fatalf("исполнитель без режимов скорости получил ключ профиля: %q", got)
	}
	typo := DispatchRequest{Stage: "PLAN", Config: map[string]string{"MODEL_DEFAULT_CODEX_SPEED": "priority"}}
	if got := typo.InheritedSpeed("codex"); got != "priority" {
		t.Fatalf("невалидный literal поддерживаемого исполнителя скрыт: %q", got)
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

// TestRefreshSelectionIgnoresRestartOrigin отделяет причину выбора от сохранённой связки.
// Новый явный выбор сбрасывает признак профильной скорости после перечитывания.
func TestRefreshSelectionIgnoresRestartOrigin(t *testing.T) {
	fast := "fast"
	standard := "standard"
	restart := state.StageRunnerRestart{
		Primary: "codex", Model: "fixture", Effort: "high", Speed: &fast, SpeedFromProfile: true,
	}
	saved := restart.Selection()
	binary, _ := writeFeatureCLI(t, "exit 0")
	input := DispatchRequest{
		Selection: restart.Selection(), SpeedFromProfile: restart.SpeedFromProfile,
		Environment: []string{"GRIGDESK_CODEX_BIN=" + binary},
		ReadSelection: func() (state.StageRunnerSelection, error) {
			return saved, nil
		},
	}
	if changed, err := input.refreshSelection(t.Context()); changed || err != nil {
		t.Fatalf("происхождение изменило сравнение selection: changed=%t: %v", changed, err)
	}
	saved.Speed = &standard
	if changed, err := input.refreshSelection(t.Context()); !changed || err != nil || input.SpeedFromProfile {
		t.Fatalf("не обновлено происхождение явного выбора: changed=%t, input=%+v: %v", changed, input, err)
	}
}

// TestDispatchReusesPreparedPromptOnSelectionConflict меняет настройку внутри BeforeInvoke.
// Повтор CAS переиспользует подготовленный prompt и запускает только новую настройку.
func TestDispatchReusesPreparedPromptOnSelectionConflict(t *testing.T) {
	run := adapterFixture(t)
	attempt, err := run.Store.ReadAttempt(run.Identity.Task, run.Identity.Attempt)
	if err != nil {
		t.Fatal(err)
	}
	id := state.StageRunnerIdentity{
		Task: attempt.Task, Profile: attempt.Profile, Attempt: attempt.ID, Node: "build", Stage: "BUILD",
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex")
	stub := `#!/bin/sh
if [ "${1:-}" = --version ]; then echo "codex-cli 0.172.0"; exit 0; fi
printf '%s\n' "$@" > "$(dirname "$0")/argv"
cat > "$(dirname "$0")/prompt"
` + submitFixtureResult + "\n"
	if err := os.WriteFile(binary, []byte(stub), 0700); err != nil {
		t.Fatal(err)
	}
	calls := 0
	input := DispatchRequest{
		Store: run.Store, Task: id.Task, Profile: id.Profile, Attempt: id.Attempt, Stage: id.Stage, Node: id.Node,
		Factory: run.Factory, Filesystem: "workspace-write", Worktree: run.Worktree, Prompt: "base",
		Environment: append(slices.Clone(run.Environment), "GRIGDESK_CODEX_BIN="+binary),
		Config:      map[string]string{"PROJECT_RUNNER_PRIMARY": "codex"},
		ReadSelection: func() (state.StageRunnerSelection, error) {
			return run.Store.ReadStageRunnerSelection(attempt, id.Node, id.Stage)
		},
		BeforeInvoke: func(prompt string) (string, error) {
			calls++
			standard := "standard"
			selection := state.StageRunnerSelection{ParametersFor: "codex", Speed: &standard}
			receipt := state.StageRunnerReceipt{
				RequestID: "new-selection", PayloadHash: strings.Repeat("a", 64), State: "saved",
			}
			_, err := run.Store.SaveStageRunnerSettings(id, 0, nil, selection,
				receipt, nil, func() error { return nil }, "")
			return prompt + " prepared", err
		},
	}
	result, err := Dispatch(t.Context(), input)
	if err != nil || calls != 1 || result.Run.Epoch != run.Identity.Epoch+1 {
		t.Fatalf("подготовка=%d, запуск=%+v: %v", calls, result, err)
	}
	checkFixtureFile(t, filepath.Join(dir, "argv"), `service_tier="default"`)
	checkFixtureFile(t, filepath.Join(dir, "prompt"), "base prepared\n")
}
