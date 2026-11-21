package engine_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDebugSettingsExpireAndInherit(t *testing.T) {
	f := newRouteFixture(t, false)
	f.expectStart(t, true)
	f = f.withDebugEnvironment()
	runners := filepath.Join(f.profile, "runners.env")
	previous, err := os.ReadFile(runners)
	if err != nil {
		t.Fatal(err)
	}
	f.debugCall(t, "1000", "settings", "debug", "set", "decisions")
	f.debugCall(t, "1000", "profile", "demo-profile", "debug", "set", "errors")
	f.debugCall(t, "1000", testTask, "debug", "set", "verbose", "--for", "1m")
	before := f.debugCall(t, "1000", testTask, "debug", "show")
	after := f.debugCall(t, "1060", testTask, "debug", "show")
	if !strings.Contains(before, "configured_expires_at: 1060\neffective: decisions\nsource: global_cap") ||
		!strings.Contains(after, "effective: errors\nsource: profile") {
		t.Fatalf("до TTL:\n%s\nпосле TTL:\n%s", before, after)
	}
	f.debugCall(t, "1060", testTask, "debug", "clear")
	if out := f.debugCall(t, "1060", testTask, "debug", "show"); !strings.Contains(out, "configured: inherit") {
		t.Fatalf("clear не восстановил наследование: %s", out)
	}
	f.readEqual(t, runners, string(previous))
}

func TestScoutDebugTrace(t *testing.T) {
	f := scoutFixture(t, `result=done`).withDebugEnvironment()
	f.debugCall(t, "1000", "settings", "debug", "set", "decisions")
	f.expectStart(t, false)
	dir := filepath.Join(f.store.StateDir, "logs", "runs", "t"+testTask, "SCOUT")
	runs, err := os.ReadDir(dir)
	if err != nil || len(runs) != 1 {
		t.Fatalf("ожидался один запуск: %v %v", runs, err)
	}
	trace, err := os.ReadFile(filepath.Join(dir, runs[0].Name(), "debug.trace.jsonl"))
	if err != nil || !strings.Contains(string(trace), `"event":"runner_exit"`) ||
		strings.Contains(string(trace), "Подтверди маршрут") {
		t.Fatalf("typed debug trace: %s %v", trace, err)
	}
}

func (f routeFixture) withDebugEnvironment() routeFixture {
	f.extraEnv = append(f.extraEnv, "FACTORY_CONFIG_ROOT="+filepath.Join(f.dir, "config"),
		"FACTORY_CONTROL_ROOT="+f.store.ControlDir, "FACTORY_STATE="+f.store.StateDir)
	return f
}

// debugCall использует CLI с тем же изолированным конфигом и фиксированными часами.
// Фикстура не меняет время и окружение остальных процессов.
func (f routeFixture) debugCall(t *testing.T, now string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	proc := exec.CommandContext(ctx, f.binary, args...)
	proc.Env = append(append(f.launchEnvironment(), f.extraEnv...), "FACTORY_DEBUG_NOW="+now)
	raw, err := proc.CombinedOutput()
	if err != nil {
		t.Fatalf("factory %v: %v\n%s", args, err, raw)
	}
	return string(raw)
}
