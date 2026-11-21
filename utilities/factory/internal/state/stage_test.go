package state

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestStageCommitCAS(t *testing.T) {
	fixture := seedHistoricalAttempt(t)
	seedHistoricalStage(t, fixture)
	before, err := fixture.store.ReadStage("51", fixture.active)
	if err != nil {
		t.Fatal(err)
	}
	command := StageCommit{
		Task: "51", Attempt: fixture.active, Node: "check", Outcome: "done",
		ExpectedSequence: before.Sequence, ExpectedHead: before.HeadEventHash,
	}
	after, err := fixture.store.CommitStage(command)
	if err != nil || after.Sequence != 2 || after.CurrentNode != "gate_plan" {
		t.Fatalf("неверный принятый cursor %+v: %v", after, err)
	}
	if _, err := fixture.store.CommitStage(command); !errors.Is(err, ErrConflict) {
		t.Fatalf("старый CAS не отклонён: %v", err)
	}
	actual, err := fixture.store.ReadStage("51", fixture.active)
	if err != nil || actual != after {
		t.Fatalf("повтор изменил цепочку: %+v, %v", actual, err)
	}
}

func TestStageReadHistorical(t *testing.T) {
	fixture := seedHistoricalAttempt(t)
	stageDir := filepath.Join(fixture.store.ControlDir, "protocol-v2", "tasks", "t51",
		"attempts", fixture.active, "stage-results")
	seedHistoricalStage(t, fixture)
	pointer, err := os.ReadFile(filepath.Join(stageDir, "runtime.json"))
	if err != nil {
		t.Fatal(err)
	}
	var expected struct {
		Runtime struct {
			Head string `json:"headEventHash"`
		} `json:"runtime"`
	}
	if err := json.Unmarshal(pointer, &expected); err != nil || expected.Runtime.Head == "" {
		t.Fatalf("исторический указатель не готов: %v", err)
	}
	projection := filepath.Join(fixture.store.StateDir, "t51.pipeline")
	if err := os.WriteFile(projection, []byte("STAGE=ship\nCATALOG_PROTOCOL=route-v2\n"), 0600); err != nil {
		t.Fatal(err)
	}
	before := stateFixtureHashes(t, fixture.store.ControlDir)
	stage, err := fixture.store.ReadStage("51", fixture.active)
	if err != nil {
		t.Fatal(err)
	}
	if stage.CurrentNode != "check" || stage.Sequence != 1 || stage.HeadEventHash != expected.Runtime.Head {
		t.Fatalf("неверная проекция stage ledger: %+v", stage)
	}
	if after := stateFixtureHashes(t, fixture.store.ControlDir); !reflect.DeepEqual(before, after) {
		t.Fatal("путь чтения переписал документы попытки")
	}
	event := filepath.Join(stageDir, "event.00000000000000000001."+stage.HeadEventHash+".json")
	data, err := os.ReadFile(event)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(event, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(event, append(data, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(event, 0400); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.ReadStage("51", fixture.active); err == nil ||
		!strings.Contains(err.Error(), "хэш события") {
		t.Fatalf("неверные байты принятого события не отклонены: %v", err)
	}
}

// seedHistoricalStage сохраняет независимые event bytes и их опубликованные хеши.
// Предшествующая запись instrument открывает узел check.
func seedHistoricalStage(t *testing.T, fixture historicalFixture) {
	t.Helper()
	attempt := filepath.Join(fixture.store.ControlDir, "protocol-v2", "tasks", "t51",
		"attempts", fixture.active)
	installHistoricalFiles(t, "stages.json", filepath.Join(attempt, "stage-results"), fixture.routes)
}
