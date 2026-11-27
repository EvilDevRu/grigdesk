package engine_test

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestResumeInvalidatesStageMetadataScopeBeforeLaunch блокирует ровно запись scope.
// После снятия отказа разведка сверяет digest до публикации своего результата.
func TestResumeInvalidatesStageMetadataScopeBeforeLaunch(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("фикстура сверяет Linux CLI и sha256sum")
	}
	f := scoutFixture(t, `result=done
hash=$(sha256sum "$0")
record=$(printf '%s\n' "$dir"/control/protocol-v2/tasks/t"$FACTORY_RUN_TASK"/attempts/*/runner-metadata.json)
if ! grep -Fq "\"digest\":\"${hash%% *}\"" "$record"; then
  touch "$dir/scope-mismatch"
fi`)
	f.expectStart(t, true)
	id := f.attempt(t)
	attempt, err := f.store.ReadAttempt(testTask, id)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(f.store.ControlDir, "protocol-v2", "tasks", "t"+testTask,
		"attempts", id, "runner-metadata.json")
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(file, 0700); err != nil {
		t.Fatal(err)
	}
	events, err := f.store.ReadLifecycle(testTask, id)
	if err != nil {
		t.Fatal(err)
	}
	if rc, out := f.run(t, "resume", "--attempt", id); rc == 0 ||
		!strings.Contains(out, "metadata_scope_invalidation_failed") {
		t.Fatalf("не остановлена инвалидация scope: rc=%d, %s", rc, out)
	}
	f.expectCount(t, "runner", "")
	after, err := f.store.ReadLifecycle(testTask, id)
	if err != nil || len(after) != len(events) {
		t.Fatalf("выпуск новой эпохи при отказе инвалидации: %v, событий %d → %d", err, len(events), len(after))
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if rc, out := f.run(t, "resume", "--attempt", id); rc != 0 {
		t.Fatalf("resume после снятия отказа: rc=%d: %s", rc, out)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "scope-mismatch")); !os.IsNotExist(err) {
		t.Fatalf("разведка не получила свой снимок до запуска: %v", err)
	}
	f.expectCount(t, "runner", "1\n")
	binary, err := os.ReadFile(filepath.Join(f.dir, "codex"))
	if err != nil {
		t.Fatal(err)
	}
	scope, problem := f.store.ReadStageMetadataScope(attempt)
	if scope == nil || scope.Providers["codex"].Digest != fmt.Sprintf("%x", sha256.Sum256(binary)) {
		t.Fatalf("не переписан снимок Codex: %+v, %s", scope, problem)
	}
}
