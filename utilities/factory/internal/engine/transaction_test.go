package engine_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
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

func TestRouteTransaction(t *testing.T) {
	for _, tc := range []struct {
		name, body, calls, scope, outside, node string
		rc                                      int
	}{
		{"restore", ":", "INSTRUMENT\nPROOF\n", "baseline\n", "outside\n", "gate_accept", 0},
		{"conflict", "printf 'чужая правка\n' >outside.txt", "INSTRUMENT\n",
			"FACTORY-TRACE:t7101\n", "чужая правка\n", "instrument", 75},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := transactionFixture(t, tc.body)
			rc, out := f.startTransaction(t)
			if rc != tc.rc || (rc == 75 && !strings.Contains(out, "out_of_scope_change")) {
				t.Fatalf("транзакция rc=%d: %s", rc, out)
			}
			f.expectCount(t, "runner", tc.calls)
			f.readEqual(t, filepath.Join(f.checkout, "scope.txt"), tc.scope)
			f.readEqual(t, filepath.Join(f.checkout, "outside.txt"), tc.outside)
			stage, err := f.store.ReadStage(testTask, f.attempt(t))
			if err != nil || stage.CurrentNode != tc.node {
				t.Fatalf("cursor %+v: %v", stage, err)
			}
		})
	}
}

func TestInterruptedTransactionCleanup(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		name := "finish"
		if conflict {
			name = "preserve-drift"
		}
		t.Run(name, func(t *testing.T) {
			f := transactionFixture(t, ":")
			index := strings.TrimSpace(f.runFixture(t, "git", "-C", f.checkout, "rev-parse", "--git-path", "index"))
			original, err := os.ReadFile(index)
			if err != nil {
				t.Fatal(err)
			}
			f.extraEnv = append(f.extraEnv, "FACTORY_INSTRUMENTATION_TEST_CRASH_AFTER_RESTORE_OBJECTS=1")
			if rc, out := f.startTransaction(t); rc != 137 {
				t.Fatalf("ожидался обрыв после первого restore, rc=%d: %s", rc, out)
			}
			id := f.attempt(t)
			root := filepath.Join(f.store.ControlDir, "transactions", "t"+testTask)
			f.readEqual(t, filepath.Join(f.checkout, "scope.txt"), "baseline\n")
			f.extraEnv = f.extraEnv[:len(f.extraEnv)-1]
			if conflict {
				f.write(t, filepath.Join(f.checkout, "outside.txt"), "ручная правка\n")
			}
			if rc, out := f.run(t, "resume", "--attempt", id); rc != 75 ||
				(conflict && !strings.Contains(out, "cleanup_resume_conflict")) {
				t.Fatalf("resume rc=%d: %s", rc, out)
			}
			f.expectCount(t, "runner", "INSTRUMENT\nPROOF\n")
			if conflict {
				if _, err := os.Stat(filepath.Join(root, "active.env")); err != nil {
					t.Fatal(err)
				}
				f.readEqual(t, filepath.Join(f.checkout, "outside.txt"), "ручная правка\n")
				return
			}
			if _, err := os.Lstat(filepath.Join(root, "active.env")); !os.IsNotExist(err) {
				t.Fatalf("active pointer пережил успешное восстановление: %v", err)
			}
			restored, err := os.ReadFile(index)
			if err != nil || !bytes.Equal(restored, original) {
				saved, _ := filepath.Glob(filepath.Join(root, "v2-*", "indexes", "*.index"))
				var backup []byte
				if len(saved) == 1 {
					backup, _ = os.ReadFile(saved[0])
				}
				t.Fatalf("Git index не восстановлен: %v, до %x, копия %x, после %x", err,
					sha256.Sum256(original), sha256.Sum256(backup), sha256.Sum256(restored))
			}
		})
	}
}

func TestTransactionNoResultRetry(t *testing.T) {
	f := transactionFixture(t, `
id=$(sed -n 's/^ *"transactionId": "\([^"]*\)".*/\1/p' <<<"$prompt")
[[ -n "$id" ]]
printf '%s\n' "$id" >>"$dir/transaction-ids"
if [[ $(wc -l <"$dir/transaction-ids") == 1 ]]; then
  exit 0
fi
`)
	if rc, out := f.startTransaction(t); rc != 0 {
		t.Fatalf("повтор INSTRUMENT rc=%d: %s", rc, out)
	}
	f.expectCount(t, "runner", "INSTRUMENT\nINSTRUMENT\nPROOF\n")
	f.readEqual(t, filepath.Join(f.checkout, "scope.txt"), "baseline\n")
	prefix := "v2-" + strings.TrimPrefix(f.attempt(t), "a_") + "-s"
	f.readEqual(t, filepath.Join(f.dir, "transaction-ids"), prefix+"0\n"+prefix+"1\n")
}

func TestStopSharedTransaction(t *testing.T) {
	const pause = `
if [[ ! -e "$dir/stop-ready" ]]; then
  touch "$dir/stop-ready"
  sleep 90
fi
`
	t.Run("instrument", func(t *testing.T) {
		testStopSharedTransaction(t, transactionFixture(t, pause), "INSTRUMENT\n", "INSTRUMENT 130\n")
	})
	t.Run("proof", func(t *testing.T) {
		f := transactionFixture(t, ":", pause)
		testStopSharedTransaction(t, f, "INSTRUMENT\nPROOF\n", "INSTRUMENT 0\nPROOF 130\n")
	})
	t.Run("verification-between-nodes", func(t *testing.T) {
		f := transactionFixture(t, ":")
		f.catalog = f.publishRoute(t, f.catalog, "Инструментация с проверкой", "skip", "zone")
		profile := filepath.Join(f.profile, "profile.sh")
		raw, err := os.ReadFile(profile)
		if err != nil {
			t.Fatal(err)
		}
		f.write(t, profile, string(raw)+`
profile_route_command() {
  [[ "$3:$4" == verify:VERIFY ]] || return 91
  local dir=$FIXTURE_ROOT
  `+pause+`
  printf '%s\n' '{"schema":1,"outcome":"done","comment":"fixture","failureOwner":null,"findings":[]}'
}
`)
		testStopSharedTransaction(t, f, "INSTRUMENT\n", "INSTRUMENT 0\n")
	})
}

// testStopSharedTransaction проверяет один и тот же exact resume с двух этапов.
// Конкурирующая задача не получает общий ресурс до terminal первой.
func testStopSharedTransaction(t *testing.T, f routeFixture, stoppedCalls, brokerClosures string) {
	t.Helper()
	f.checkout = filepath.Join(f.dir, "tx-source")
	f.extraEnv = append(f.extraEnv, "FIXTURE_CHECKOUT="+f.checkout)
	f.useSharedClaude(t)
	profile := filepath.Join(f.profile, "profile.sh")
	raw, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	f.write(t, profile, string(raw)+`
profile_workspace_mode() { printf 'shared\n'; }
profile_source_branch() { printf 'shared-main\n'; }
profile_agent_control_start() {
  fixture_control_shell=$BASHPID
  export PROFILE_AGENT_CONTROL_DIR="$FIXTURE_ROOT/broker"
  mkdir -m 700 -- "$PROFILE_AGENT_CONTROL_DIR"
}
profile_agent_control_stop() {
  [[ "$fixture_control_shell" == "$BASHPID" ]] || return 93
  rmdir -- "$PROFILE_AGENT_CONTROL_DIR" || return
  printf '%s %s\n' "$2" "$3" >>"$FIXTURE_ROOT/broker.count"
}
profile_instrumentation_restored() {
  [[ "$1" == 7101 && -r "$2" ]] || return 90
  grep -Fxq "$FIXTURE_CHECKOUT/scope.txt" "$2" || return 91
  grep -Fxq baseline "$FIXTURE_CHECKOUT/scope.txt" || return 92
  printf 'restored\n' >>"$FIXTURE_ROOT/restore.count"
}
`)
	f.stopTransaction(t)
	f.expectCount(t, "runner", stoppedCalls)
	f.expectCount(t, "broker", brokerClosures)
	f.readEqual(t, filepath.Join(f.checkout, "scope.txt"), "baseline\n")
	f.readEqual(t, filepath.Join(f.dir, "restore.count"), "restored\n")
	if f.projection(t)["STOPPED_SIGNAL"] != "1" {
		t.Fatal("сигнал не зафиксирован")
	}
	id := f.attempt(t)
	contender := state.Attempt{Task: "7102", ID: "pending", Profile: "demo-profile"}
	resources := []string{"stand:fixture-stand", "workspace:" + f.checkout}
	if err := f.store.SharedLease(contender, resources, "reserve"); !errors.Is(err, state.ErrConflict) {
		t.Fatalf("Stop освободил shared-аренду: %v", err)
	}
	if rc, out := f.run(t, "resume", "--attempt", id); rc != 0 {
		t.Fatalf("возобновление после подтверждённого Stop rc=%d: %s", rc, out)
	}
	f.expectCount(t, "runner", stoppedCalls+"INSTRUMENT\nPROOF\n")
	stage, err := f.store.ReadStage(testTask, id)
	if err != nil || stage.State != "paused" || stage.CurrentNode != "gate_accept" {
		t.Fatalf("возврат к воротам: %+v %v", stage, err)
	}
	exact := fmt.Sprintf("%d:%s", stage.Sequence, stage.HeadEventHash)
	if rc, out := f.run(t, "gate", gateOptions(id, exact, "approved")...); rc != 0 {
		t.Fatalf("gate rc=%d: %s", rc, out)
	}
	if rc, out := f.run(t, "resume", "--attempt", id); rc != 0 {
		t.Fatalf("terminal resume rc=%d: %s", rc, out)
	}
	if err := f.store.SharedLease(contender, resources, "reserve"); err != nil {
		t.Fatalf("terminal не освободил shared-аренду: %v", err)
	}
}

// useSharedClaude использует поддерживаемый shared adapter с тестовым CLI.
// Settings принадлежат временному control root и закрывают его для инструментов.
func (f *routeFixture) useSharedClaude(t *testing.T) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.dir, "codex"))
	if err != nil {
		t.Fatal(err)
	}
	script := strings.ReplaceAll(string(raw), "codex-cli 0.106.0", "2.1.63 (Claude Code)")
	script = strings.ReplaceAll(script, "prompt=$(cat)", "[[ $1 == -p ]]\nprompt=$2")
	claude := filepath.Join(f.dir, "claude")
	f.write(t, claude, script)
	if err := os.Chmod(claude, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(f.store.ControlDir, 0700); err != nil {
		t.Fatal(err)
	}
	var deny []string
	control := "//" + strings.TrimPrefix(f.store.ControlDir, "/")
	for _, tool := range []string{"Read", "Edit", "Write", "NotebookEdit"} {
		deny = append(deny, fmt.Sprintf("%q", tool+"("+control+")"), fmt.Sprintf("%q", tool+"("+control+"/**)"))
	}
	settings := filepath.Join(f.store.ControlDir, "claude-settings.json")
	f.write(t, settings, `{"permissions":{"deny":[`+strings.Join(deny, ",")+"]}}")
	if err := os.Chmod(settings, 0400); err != nil {
		t.Fatal(err)
	}
	f.extraEnv = append(f.extraEnv, "GRIGDESK_CLAUDE_BIN="+claude, "RUNNER_CLAUDE_SETTINGS="+settings)
	f.write(t, filepath.Join(f.profile, "runners.env"), "RUNNERS_SCHEMA=1\nCONFIG_REVISION=1\n"+
		"RUNNERS_COVERAGE=required\nPROJECT_RUNNER_PRIMARY=claude\nPROJECT_RUNNER_FAILOVER=\n")
}

// stopTransaction ждёт метку входа тестового провайдера после изменения scope.
// Сигнал отправляется лишь тому процессу Go, который создала эта фикстура.
func (f routeFixture) stopTransaction(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	cmd := f.factoryCommand(ctx, "start", f.transactionStartOptions()...)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Lstat(filepath.Join(f.dir, "stop-ready")); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("провайдер не достиг Stop: %v: %s", err, output.String())
		case <-ctx.Done():
			t.Fatal("провайдер не достиг барьера Stop")
		case <-ticker.C:
		}
	}
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	var result *exec.ExitError
	if err := <-done; !errors.As(err, &result) || result.ExitCode() != 130 {
		t.Fatalf("Stop rc: %v: %s", err, output.String())
	}
}

// transactionFixture использует linked worktree и тот же статусный CLI, что provider.
// Тестовый агент оставляет следы только в собственном временном каталоге.
func transactionFixture(t *testing.T, extra string, proof ...string) routeFixture {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("проверка Linux-контракта транзакции")
	}
	f := scoutFixture(t, "result=done")
	source := filepath.Join(f.dir, "tx-source")
	if err := os.Rename(f.checkout, source); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) string {
		return strings.TrimSpace(f.runFixture(t, "git", append([]string{"-C", source}, args...)...))
	}
	for _, name := range []string{"scope.txt", "outside.txt"} {
		blob := git("hash-object", "-w", name)
		git("update-index", "--add", "--cacheinfo", "100644,"+blob+","+name)
	}
	head := git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
		"commit-tree", git("write-tree"), "-m", "Baseline")
	git("update-ref", "refs/heads/shared-main", head)
	git("worktree", "add", "-qb", "fixture-transaction", f.checkout, head)
	profile := filepath.Join(f.profile, "profile.sh")
	raw, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	f.write(t, profile, string(raw)+"\nprofile_source_branch() { printf 'fixture-transaction\\n'; }\n")
	up := filepath.Join(f.profile, "up.sh")
	raw, err = os.ReadFile(up)
	if err != nil {
		t.Fatal(err)
	}
	f.write(t, up, strings.ReplaceAll(string(raw), "shared-main", "fixture-transaction"))
	f.extraEnv = append(f.extraEnv, "FIXTURE_SOURCE="+source)
	f.catalog = f.publishRoute(t, f.catalog, "Инструментация", "skip", "explicit")
	f.write(t, filepath.Join(f.dir, "codex"), `#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == --version ]]; then
  printf '%s\n' 'codex-cli 0.106.0'
  exit 0
fi
prompt=$(cat)
scope=$(sed -n 's/^ *"scopeFile": "\([^"]*\)".*/\1/p' <<<"$prompt")
grep -Fxq "$PWD/scope.txt" "$scope"
dir=$(dirname -- "$0")
printf '%s\n' "$FACTORY_RUN_STAGE" >>"$dir/runner.count"
if [[ "$FACTORY_RUN_STAGE" == INSTRUMENT ]]; then
  printf 'FACTORY-TRACE:t7101\n' >scope.txt
  git update-index --cacheinfo "100644,$(git hash-object -w scope.txt),scope.txt"
  `+extra+`
else
  grep -Fxq 'FACTORY-TRACE:t7101' scope.txt
  `+strings.Join(proof, "\n")+`
fi
"$FACTORY_STATUS_BIN" stage-result --task "$FACTORY_RUN_TASK" \
  --stage "$FACTORY_RUN_STAGE" --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" done
`)
	if err := os.Chmod(filepath.Join(f.dir, "codex"), 0700); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f routeFixture) startTransaction(t *testing.T, extra ...string) (int, string) {
	t.Helper()
	return f.run(t, "start", append(f.transactionStartOptions(), extra...)...)
}

func (f routeFixture) transactionStartOptions() []string {
	return []string{"--route", "command", "--ticket-json", filepath.Join(f.dir, "ticket.json"),
		"--expected-catalog-hash", f.catalog, "--instrumentation-file", "app:scope.txt"}
}

// TestTransactionKeepsPreparedScopeOnRunnerSettingsConflict меняет выбор под живым lock.
// Одна эпоха INSTRUMENT и обычный PROOF должны восстановить файлы и убрать active pointer.
func TestTransactionKeepsPreparedScopeOnRunnerSettingsConflict(t *testing.T) {
	f := transactionFixture(t, `printf '%s\n' "$@" >"$dir/instrument.argv"`)
	bin := filepath.Join(f.dir, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	ready, release := filepath.Join(f.dir, "tx-ready"), filepath.Join(f.dir, "tx-release")
	wrapper := filepath.Join(bin, "git")
	f.write(t, wrapper, fmt.Sprintf(`#!/bin/bash
if [[ "$3:${5:-}" == rev-parse:--git-dir && ! -e %q ]]; then
  touch %q
  for ((i=0; i<250; i++)); do
    [[ ! -e %q ]] || break
    sleep .04
  done
  [[ -e %q ]] || exit 91
fi
exec %q "$@"
`, ready, ready, release, release, git))
	if err := os.Chmod(wrapper, 0700); err != nil {
		t.Fatal(err)
	}
	f.extraEnv = append(f.extraEnv, "PATH="+bin+":"+os.Getenv("PATH"))
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	cmd := f.factoryCommand(ctx, "start", f.transactionStartOptions()...)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	wait := make(chan error, 1)
	go func() {
		wait <- cmd.Wait()
	}()
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		select {
		case err := <-wait:
			t.Fatalf("запуск завершился до захвата lock: %v %s", err, &output)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(15 * time.Millisecond):
		}
	}
	id := f.attempt(t)
	attempt, err := f.store.ReadAttempt(testTask, id)
	if err != nil {
		t.Fatal(err)
	}
	scope, _ := f.store.ReadStageMetadataScope(attempt)
	identity := state.StageRunnerIdentity{
		Task: testTask, Profile: attempt.Profile, Attempt: id, Node: "instrument", Stage: "INSTRUMENT",
	}
	standard := "standard"
	selection := state.StageRunnerSelection{ParametersFor: "codex", Speed: &standard}
	receipt := state.StageRunnerReceipt{
		RequestID: "instrument-next", PayloadHash: strings.Repeat("a", 64), State: "saved",
	}
	if _, err := f.store.SaveStageRunnerSettings(identity, 0, nil, selection,
		receipt, nil, func() error { return nil }, scope.Fingerprint()); err != nil {
		t.Fatal(err)
	}
	f.write(t, release, "")
	if err := <-wait; err != nil {
		t.Fatalf("запуск после конфликта: %v %s", err, &output)
	}
	f.expectCount(t, "runner", "INSTRUMENT\nPROOF\n")
	argv, err := os.ReadFile(filepath.Join(f.dir, "instrument.argv"))
	if err != nil || !bytes.Contains(argv, []byte(`service_tier="default"`)) {
		t.Fatalf("инструментация получила прежний выбор: %q %v", argv, err)
	}
	if f.projection(t)["ACTIVE_EPOCH_INSTRUMENT"] != "1" {
		t.Fatal("конфликт израсходовал эпоху инструментации")
	}
	f.readEqual(t, filepath.Join(f.checkout, "scope.txt"), "baseline\n")
	active := filepath.Join(f.store.ControlDir, "transactions", "t"+testTask, "active.env")
	if _, err := os.Lstat(active); !os.IsNotExist(err) {
		t.Fatalf("временная инструментация не снята: %v", err)
	}
}
