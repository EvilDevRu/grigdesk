package state

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSaveStageRunnerSettingsRejectsStaleScope сверяет запись под тем же task lock.
// При несовпадении каталога ни выбор, ни ревизия не меняются.
func TestSaveStageRunnerSettingsRejectsStaleScope(t *testing.T) {
	fx := seedHistoricalAttempt(t)
	store := fx.store
	attempt, err := store.ReadAttempt("51", fx.active)
	if err != nil {
		t.Fatal(err)
	}
	id := StageRunnerIdentity{
		Task: attempt.Task, Profile: attempt.Profile, Attempt: attempt.ID, Node: "build", Stage: "BUILD",
	}
	selection := StageRunnerSelection{Primary: "codex", ParametersFor: "codex"}
	save := func(revision uint64, request, fingerprint string) (StageRunnerSettings, error) {
		receipt := StageRunnerReceipt{RequestID: request, PayloadHash: strings.Repeat("a", 64), State: "saved"}
		return store.SaveStageRunnerSettings(id, revision, nil, selection, receipt, nil,
			func() error { return nil }, fingerprint)
	}
	writeScope := func(scope StageMetadataScope) {
		t.Helper()
		task, err := store.openTask(id.Task, true)
		if err != nil {
			t.Fatal(err)
		}
		defer task.close()
		if err := task.writeStageMetadataScope(attempt, scope); err != nil {
			t.Fatal(err)
		}
	}
	publish := func(name string) string {
		t.Helper()
		binary := filepath.Join(t.TempDir(), "codex")
		if err := os.WriteFile(binary, []byte(name), 0700); err != nil {
			t.Fatal(err)
		}
		digest, err := StageMetadataExecutableDigest(binary)
		if err != nil {
			t.Fatal(err)
		}
		scope := StageMetadataScope{Providers: map[string]StageMetadataCLI{
			"codex": {Executable: binary, Digest: digest},
		}}
		writeScope(scope)
		return scope.Fingerprint()
	}
	if saved, err := save(0, "absent", ""); err != nil || saved.Revision != 1 {
		t.Fatalf("отсутствующая запись: %+v, %v", saved, err)
	}
	writeScope(StageMetadataScope{})
	if saved, err := save(1, "invalidated", ""); err != nil || saved.Revision != 2 {
		t.Fatalf("пустая запись: %+v, %v", saved, err)
	}
	a, b := publish("copy-a"), publish("copy-b")
	for _, stale := range []string{a, ""} {
		if _, err := save(2, "stale", stale); !errors.Is(err, ErrConflict) ||
			!strings.Contains(err.Error(), "catalog_stale") {
			t.Fatalf("устаревший отпечаток принят: %v", err)
		}
	}
	current, err := store.ReadStageRunnerSettings(id)
	if err != nil || current.Revision != 2 || current.Receipt.RequestID != "invalidated" {
		t.Fatalf("конфликт изменил запись: %+v, %v", current, err)
	}
	if saved, err := save(2, "fresh", b); err != nil || saved.Revision != 3 {
		t.Fatalf("актуальная запись: %+v, %v", saved, err)
	}
}

// TestCheckStageAdmissionSelectionUsesSavedSelection проверяет один снимок в обеих ветках.
// Отрицательная проверка и конфликт выдачи не публикуют epoch.
func TestCheckStageAdmissionSelectionUsesSavedSelection(t *testing.T) {
	fx := seedHistoricalAttempt(t)
	attempt, err := fx.store.ReadAttempt("51", fx.active)
	if err != nil {
		t.Fatal(err)
	}
	id := StageRunnerIdentity{
		Task: attempt.Task, Profile: attempt.Profile, Attempt: attempt.ID, Node: "build", Stage: "BUILD",
	}
	if err := fx.store.CheckStageAdmissionSelection(id, StageSelectionAdmission{}); err != nil {
		t.Fatal(err)
	}
	expected := StageSelectionAdmission{Selection: StageRunnerSelection{ParametersFor: "codex"}}
	if err := fx.store.CheckStageAdmissionSelection(id, expected); !errors.Is(err, ErrConflict) {
		t.Fatalf("несохранённая связка принята: %v", err)
	}
	run, token, rc, err := fx.store.NextRunWithSelection(id.Task, id.Attempt, id.Node, id.Stage, "", expected)
	if token != "" || rc != 75 || !errors.Is(err, ErrConflict) {
		t.Fatalf("выдано право при конфликте: rc=%d, %v", rc, err)
	}
	if _, rc, err := fx.store.ReadRun(run); rc != 73 || err == nil {
		t.Fatalf("после конфликта появился запуск: rc=%d, %v", rc, err)
	}
}
