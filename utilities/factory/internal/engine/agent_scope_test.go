package engine

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"grigdesk.local/tools/utilities/factory/internal/runner"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

// TestRunnerRequestCarriesMetadataScope проверяет доверенный вход dispatcher.
// Повреждение или исчезновение CLI ограничивают только допуск скорости.
func TestRunnerRequestCarriesMetadataScope(t *testing.T) {
	root := t.TempDir()
	store := state.Store{StateDir: filepath.Join(root, "state"), ControlDir: filepath.Join(root, "control")}
	if err := os.Mkdir(store.StateDir, 0700); err != nil {
		t.Fatal(err)
	}
	routes := filepath.Join(root, "routes")
	publisher := filepath.Join("..", "..", "..", "..", "tests", "engine", "fixtures", "routes-publish.mjs")
	cmd := exec.CommandContext(t.Context(), "node", publisher, routes, "Metadata scope", "null")
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + root}
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("публикация маршрута: %v: %s", err, output)
	}
	attempt, rc, err := store.BeginAttempt(state.BeginInput{
		Task: "8101", Profile: "demo-profile", RoutesDir: routes,
	})
	if rc != 0 || err != nil {
		t.Fatalf("фикстура попытки: rc=%d: %v", rc, err)
	}
	attempt, err = store.SelectRoute(attempt.Task, attempt.ID, "debug")
	if err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(root, "codex")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nexit 4\n"), 0700); err != nil {
		t.Fatal(err)
	}
	environment := []string{"GRIGDESK_CODEX_BIN=" + cli, "GRIGDESK_CLAUDE_BIN=/absent", "HOME=" + root}
	if _, err := runner.SaveStageMetadataScope(attempt, store, root, environment); err != nil {
		t.Fatal(err)
	}
	e := execution{
		request: LaunchRequest{Store: store, Environment: environment, Log: io.Discard},
		attempt: attempt, runnerConfig: map[string]string{"PROJECT_RUNNER_PRIMARY": "codex"},
	}
	e.invoke.Directory = root
	read := func() *state.StageMetadataScope {
		t.Helper()
		request, err := e.runnerRequest(state.StageSnapshot{CurrentNode: "build"},
			map[string]any{"policy": map[string]any{"filesystem": "workspace-write"}}, "BUILD", "fixture")
		if err != nil {
			t.Fatal(err)
		}
		return request.MetadataScope
	}
	scope, _ := store.ReadStageMetadataScope(attempt)
	if got := read(); scope.Fingerprint() == "" || got.Fingerprint() != scope.Fingerprint() {
		t.Fatalf("запуск не получил подтверждённый снимок: %+v", got)
	}
	file := filepath.Join(store.ControlDir, "protocol-v2", "tasks", "t"+attempt.Task,
		"attempts", attempt.ID, "runner-metadata.json")
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != nil {
		t.Fatalf("отсутствующая запись активна: %+v", got)
	}
	foreign := *scope
	foreign.Attempt = "a_0123456789abcdef0123456789abcdef"
	raw, err := json.Marshal(foreign)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != nil {
		t.Fatalf("чужая запись активна: %+v", got)
	}
	if err := store.WriteStageMetadataScope(attempt, *scope); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(cli); err != nil {
		t.Fatal(err)
	}
	if got := read(); got == nil || len(got.Providers) != 0 {
		t.Fatalf("исчезнувший CLI остался в записи: %+v", got)
	}
}
