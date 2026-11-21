package state

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReplayStaleForeign(t *testing.T) {
	for _, mode := range []string{"source-drift", "cursor-advanced", "foreign"} {
		t.Run(mode, func(t *testing.T) {
			fixture, input, cursor := readyReceiptFixture(t)
			path := receiptFixturePath(fixture)
			tree := input.Tree
			if mode == "foreign" {
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				modified := bytes.Replace(raw, []byte(`"taskId":"51"`), []byte(`"taskId":"71"`), 1)
				if bytes.Equal(modified, raw) {
					t.Fatal("не подменена identity фикстуры")
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, modified, 0400); err != nil {
					t.Fatal(err)
				}
				_, _, rc, err := fixture.store.ReplayPending(input.Task, input.Attempt, tree)
				if rc != 78 || err == nil || !strings.Contains(err.Error(), "identity попытки изменилась") {
					t.Fatalf("foreign rc=%d, ошибка=%v", rc, err)
				}
				verifyFileBytes(t, path, modified)
				return
			}
			if mode == "cursor-advanced" {
				_, err := fixture.store.PauseStage(input.Task, input.Attempt, cursor, "manual")
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(tree, []byte("новые исходники\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			_, status, rc, err := fixture.store.ReplayPending(input.Task, input.Attempt, tree)
			if rc != 3 || err != nil || status != "stale" {
				t.Fatalf("старая квитанция: rc=%d статус=%s %v", rc, status, err)
			}
			file := "pending-transition.stale." + cursor.HeadEventHash + ".json"
			archive := filepath.Join(filepath.Dir(path), file)
			if _, err := os.Stat(archive); err != nil {
				t.Fatalf("квитанция не архивирована именем базы: %v", err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("исходная квитанция не убрана: %v", err)
			}
			t.Logf("rc=3, архив=%s", filepath.Base(archive))
		})
	}
}

// readyReceiptFixture создаёт свой physical cursor и настоящий receipt writer.
func readyReceiptFixture(t *testing.T) (historicalFixture, PendingRequest, StageSnapshot) {
	t.Helper()
	fixture := seedHistoricalAttempt(t)
	seedHistoricalStage(t, fixture)
	cursor, err := fixture.store.ReadStage("51", fixture.active)
	if err != nil {
		t.Fatal(err)
	}
	input := PendingRequest{
		Task: "51", Attempt: fixture.active, ExpectedHead: cursor.HeadEventHash, Sequence: cursor.Sequence,
		Tree: filepath.Join(filepath.Dir(fixture.store.ControlDir), "guard.snapshot"),
		Args: []string{"51", fixture.active, cursor.CurrentNode, "done", "0", "", "0", "0", "0", "", "0"},
	}
	if err := os.WriteFile(input.Tree, []byte("проверенный исходный снимок\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.PreparePending(input); err != nil {
		t.Fatal(err)
	}
	return fixture, input, cursor
}

func receiptFixturePath(fixture historicalFixture) string {
	return filepath.Join(fixture.store.ControlDir, "protocol-v2", "tasks", "t51",
		"attempts", fixture.active, pendingFile)
}

func verifyFileBytes(t *testing.T, name string, expected []byte) {
	t.Helper()
	raw, err := os.ReadFile(name)
	if err != nil || !bytes.Equal(raw, expected) {
		t.Fatalf("изменены байты %s: %v", name, err)
	}
}
