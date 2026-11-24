package engine_test

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

// TestResumeClosedAgent проверяет настоящий CLI и хостовый запуск провайдера.
// Успешное продолжение использует прежний курсор, вручную менять его не требуется.
func TestResumeClosedAgent(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("фикстура использует Linux-сигнал и дерево процессов")
	}
	for _, reason := range []string{"process_exit", "signal", "workspace_change"} {
		t.Run(reason, func(t *testing.T) {
			f := scoutFixture(t, "result=done")
			f.catalog = f.publishRoute(t, f.catalog, "Повтор агента", "skip", "read-agent")
			configureClosedAgent(t, f, reason)
			if reason == "signal" {
				interruptAgentProcess(t, f)
			} else if rc, out := f.start(t, false); rc != 75 || strings.Contains(out, "lifecycle:") {
				t.Fatalf("отказ запуска rc=%d: %s", rc, out)
			}
			id := f.attempt(t)
			events, err := f.store.ReadLifecycle(testTask, id)
			if err != nil {
				t.Fatal(err)
			}
			closed := false
			for _, event := range events {
				if event.Data["kind"] == "node_execution_finished" {
					details := event.Data["details"].(map[string]any)
					closed = details["reasonCode"] == reason && details["productOutcomeSource"] == "none"
				}
			}
			rc, output := f.run(t, "resume", "--attempt", id)
			if reason == "workspace_change" {
				if closed || rc != 75 || !strings.Contains(output, "исход предыдущего запуска не подтверждён") {
					t.Fatalf("снята защита workspace: closed=%v rc=%d %s", closed, rc, output)
				}
				f.expectCount(t, "runner", "1\n")
				return
			}
			if !closed || rc != 0 {
				t.Fatalf("исход=%s подтверждён=%v, resume rc=%d: %s", reason, closed, rc, output)
			}
			f.expectCount(t, "runner", "1\n1\n")
			stage, err := f.store.ReadStage(testTask, id)
			if err != nil || stage.CurrentNode != "gate_accept" || stage.State != "paused" {
				t.Fatalf("ожидались ворота после плана: %+v %v", stage, err)
			}
		})
	}
}

// configureClosedAgent завершает первый вызов, а во втором возвращает готовый план.
// Модель заменена локальным CLI, чтобы проверить переходы независимо от провайдера.
func configureClosedAgent(t *testing.T, f routeFixture, reason string) {
	t.Helper()
	action := "exit 1"
	switch reason {
	case "signal":
		action = "exec sleep 30"
	case "workspace_change":
		action = "printf 'изменено\n' >\"" + filepath.Join(f.checkout, "scope.txt") + "\"; exit 1"
	}
	path := filepath.Join(f.dir, "codex")
	f.write(t, path, `#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == --version ]]; then
  printf '%s\n' 'codex-cli 0.106.0'
  exit 0
fi
dir=$(dirname -- "$0")
cat >/dev/null
if [[ ! -s "$dir/runner.count" ]]; then
  printf '1\n' >>"$dir/runner.count"
  `+action+`
fi
printf '1\n' >>"$dir/runner.count"
"$FACTORY_STATUS_BIN" stage-result --task "$FACTORY_RUN_TASK" \
  --stage "$FACTORY_RUN_STAGE" --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" done
`)
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
}

// interruptAgentProcess ждёт запуска провайдера и посылает штатный сигнал остановки.
// Контрольная точка берётся из файла фикстуры, поэтому сигнал попадает в работающий узел.
func interruptAgentProcess(t *testing.T, f routeFixture) {
	t.Helper()
	cmd := f.factoryCommand(t.Context(), "start", "--route", "command",
		"--ticket-json", filepath.Join(f.dir, "ticket.json"), "--expected-catalog-hash", f.catalog)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
	})
	deadline := time.Now().Add(12 * time.Second)
	for {
		stat, err := os.Stat(filepath.Join(f.dir, "runner.count"))
		if err == nil && stat.Size() > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("исполнитель этапа не запустился")
		}
		time.Sleep(20 * time.Millisecond)
	}
	checkSettingsWhileAgentRuns(t, f)
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	err := cmd.Wait()
	var exited *exec.ExitError
	if !errors.As(err, &exited) || exited.ExitCode() != 130 {
		t.Fatalf("остановка: %v %s", err, output.String())
	}
}

// checkSettingsWhileAgentRuns проверяет независимость будущего этапа от работающего.
// Сохранение без актуального run для самого работающего PLAN по-прежнему конфликтует.
func checkSettingsWhileAgentRuns(t *testing.T, f routeFixture) {
	t.Helper()
	id := state.StageRunnerIdentity{
		Task: testTask, Profile: "demo-profile", Attempt: f.attempt(t), Node: "plan", Stage: "PLAN",
	}
	actual, err := f.store.ReadStageRunnerActual(id)
	if err != nil || actual == nil {
		t.Fatalf("нет живого PLAN: %+v %v", actual, err)
	}
	selection := state.StageRunnerSelection{Primary: "codex", ParametersFor: "codex"}
	receipt := state.StageRunnerReceipt{
		RequestID: "2ace21bb-166f-40dd-9192-59d378807fde", PayloadHash: strings.Repeat("a", 64), State: "saved",
	}
	validate := func() error { return nil }
	if _, err := f.store.SaveStageRunnerSettings(id, 0, nil, selection, receipt, nil, validate); !errors.Is(err, state.ErrConflict) {
		t.Fatalf("снимок работающего этапа принят без run: %v", err)
	}
	id.Node, id.Stage = "skeptic", "SKEPTIC"
	saved, err := f.store.SaveStageRunnerSettings(id, 0, nil, selection, receipt, nil, validate)
	if err != nil || saved.Revision != 1 || saved.Selection.Primary != "codex" {
		t.Fatalf("сохранение будущего узла во время PLAN: %+v %v", saved, err)
	}
}
