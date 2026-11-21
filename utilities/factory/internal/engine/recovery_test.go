package engine_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

func TestUnknownSideEffect(t *testing.T) {
	f := newRouteFixture(t, false)
	profile := filepath.Join(f.profile, "profile.sh")
	raw, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	replacement := strings.Replace(string(raw), "  :\n", "  exit 17\n", 1)
	if replacement == string(raw) {
		t.Fatal("фикстура не моделирует падение после эффекта")
	}
	f.write(t, profile, replacement)
	if rc, text := f.start(t, false); rc != 75 {
		t.Fatalf("команда не дошла до контролируемого отказа: rc=%d %s", rc, text)
	}
	attempt := f.attempt(t)
	for i := 0; i < 2; i++ {
		rc, out := f.run(t, "resume", "--attempt", attempt)
		if rc != 75 || !strings.Contains(out, "исход предыдущего вызова не подтверждён") {
			t.Fatalf("неопределённый эффект не остановил resume: rc=%d %s", rc, out)
		}
		f.expectCount(t, "command", "1\n")
	}
}

// TestPendingTransitionCrash проверяет публичный resume после durable cursor и receipt.
// Второй запуск не выполняет повторный command, а достраивает ранее отставшую витрину.
func TestPendingTransitionCrash(t *testing.T) {
	f := newRouteFixture(t, false)
	f.expectStart(t, true)
	attempt := f.attempt(t)
	before, err := f.store.InitStage(testTask, attempt)
	if err != nil {
		t.Fatal(err)
	}
	f.write(t, filepath.Join(f.dir, "command.count"), "1\n")
	tree := filepath.Join(f.dir, "guard.fixture")
	f.write(t, tree, "проверенные bytes")
	args := []string{testTask, attempt, before.CurrentNode, "done", "0", "", "0", "0", "0", "", "0"}
	if err := f.store.PreparePending(state.PendingRequest{
		Task: testTask, Attempt: attempt, Sequence: before.Sequence, ExpectedHead: before.HeadEventHash,
		Tree: tree, Args: args,
	}); err != nil {
		t.Fatal(err)
	}
	committed, err := f.store.CommitStage(state.StageCommit{
		Task: testTask, Attempt: attempt, Node: before.CurrentNode, Outcome: "done",
		ExpectedSequence: before.Sequence, ExpectedHead: before.HeadEventHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if rc, text := f.run(t, "resume", "--attempt", attempt); rc != 0 {
			t.Fatalf("resume подтверждённого перехода: rc=%d %s", rc, text)
		}
	}
	f.assertGate(t)
	if f.projection(t)["VERIFY"] != "done" {
		t.Fatal("проекция принятого узла не восстановлена")
	}
	t.Logf("committed command head=%s, effects=1, resumed twice", committed.HeadEventHash)
}
