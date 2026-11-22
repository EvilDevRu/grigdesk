package state

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestWindowsTrustedState(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := Store{
		ControlDir: filepath.Join(base, "control"),
		StateDir:   filepath.Join(base, "state"),
	}
	first, rc, err := store.LockOrchestrator("812")
	if rc != 0 || err != nil {
		t.Fatalf("не взят lock: %d, %v", rc, err)
	}
	defer first.Close()
	if contender, rc, err := store.LockOrchestrator("812"); rc != 73 || err == nil {
		if contender != nil {
			contender.Close()
		}
		t.Fatalf("конкурент получил lock: %d, %v", rc, err)
	}

	task, err := store.openTask("812", true)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"first", "second"} {
		if err := publishFile(task.root, "sample", []byte(expected), immutableMode, expected == "second"); err != nil {
			task.close()
			t.Fatal(err)
		}
	}
	if err := publishFile(task.root, "sample", []byte("unexpected"), immutableMode, false); !errors.Is(err, ErrConflict) {
		task.close()
		t.Fatalf("дублирующая запись не отклонена: %v", err)
	}
	task.close()

	task, err = store.openTask("812", false)
	if err != nil {
		t.Fatal(err)
	}
	defer task.close()
	data, err := readTrusted(task.root, "sample", 20, immutableMode)
	if err != nil || string(data) != "second" {
		t.Fatalf("состояние не восстановилось после закрытия handle: %q, %v", data, err)
	}
}
