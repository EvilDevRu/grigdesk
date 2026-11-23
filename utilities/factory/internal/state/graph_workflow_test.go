package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"grigdesk.local/tools/utilities/factory/internal/graphworkflow"
)

type graphInputFile = graphworkflow.InputFile
type graphSnapshot = graphworkflow.Snapshot

func TestGraphWorkflowKeepsAcceptedSnapshotOnRepeatedStart(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	key := "d11dce6a-b7cc-4654-96b4-3ea48ed46a81"
	created := []byte(`{"format":1,"id":"d11dce6a-b7cc-4654-96b4-3ea48ed46a81","revision":1}`)

	first, err := store.StartGraphDocument(key, strings.Repeat("a", 64), created)
	if err != nil || !reflect.DeepEqual(first, created) {
		t.Fatalf("старт не сохранил initial snapshot: %s %v", first, err)
	}
	workerState := []byte(`{"format":1,"id":"d11dce6a-b7cc-4654-96b4-3ea48ed46a81","revision":2}`)
	if err := store.WriteGraphDocument(key, strings.Repeat("a", 64), 1, workerState); err != nil {
		t.Fatal(err)
	}

	reopened := Store{ControlDir: root}
	replay, err := reopened.StartGraphDocument(key, strings.Repeat("a", 64), created)
	if err != nil || !reflect.DeepEqual(replay, workerState) {
		t.Fatalf("повтор старта должен вернуть уже принятый снимок: %s %v", replay, err)
	}
	if _, err := reopened.StartGraphDocument(key, strings.Repeat("b", 64), created); !errors.Is(err, ErrConflict) {
		t.Fatalf("один ключ с иным входом должен конфликтовать: %v", err)
	}
	if err := reopened.WriteGraphDocument(key, strings.Repeat("a", 64), 1, created); !errors.Is(err, ErrConflict) {
		t.Fatalf("запись прежнего состояния должна конфликтовать: %v", err)
	}
}

func graphTemplateDoc(title string) []byte {
	return []byte(`{"title":"` + title + `","inputKind":"documents","scope":{"returns":["source"],` +
		`"steps":[{"id":"source","title":"Источник","kind":"input"}]}}`)
}

func TestGraphWorkflowTemplateConflictAndSnapshot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	runID := "74906bac-48d5-40ce-a6a9-96cbce242146"

	headerA, _, err := store.SaveGraphTemplate(templateID, nil, graphTemplateDoc("A"))
	if err != nil {
		t.Fatal(err)
	}
	request := GraphStartRequest{
		ID: runID, TemplateID: templateID, ExpectedRevision: headerA.Revision,
		Files: []graphInputFile{{Name: "a.txt", Text: "вход"}},
	}
	if _, err := store.StartGraphRun(request, 1000); err != nil {
		t.Fatal(err)
	}
	headerB, _, err := store.SaveGraphTemplate(templateID, &headerA.Revision, graphTemplateDoc("B"))
	if err != nil {
		t.Fatal(err)
	}
	if headerB.Revision == headerA.Revision {
		t.Fatalf("редакция B должна отличаться от A")
	}
	stale := "0000000000000000000000000000000000000000000000000000000000000000"
	if _, _, err := store.SaveGraphTemplate(templateID, &stale, graphTemplateDoc("C")); !errors.Is(err, ErrConflict) {
		t.Fatalf("save со старым хешем должен конфликтовать: %v", err)
	}
	if _, _, err := store.SaveGraphTemplate(templateID, &headerA.Revision, graphTemplateDoc("C")); !errors.Is(err, ErrConflict) {
		t.Fatalf("save с прежней редакцией после B должен конфликтовать: %v", err)
	}
	_, snapshot, err := store.ReadGraphRun(runID)
	if err != nil || snapshot.Definition.Title != "A" {
		t.Fatalf("прежний прогон читает собственное определение A: %+v %v", snapshot, err)
	}
	newRunID := "b1690525-b349-422c-a165-778def939e5c"
	request.ID = newRunID
	request.ExpectedRevision = headerB.Revision
	if _, err := store.StartGraphRun(request, 2000); err != nil {
		t.Fatal(err)
	}
	_, newSnapshot, err := store.ReadGraphRun(newRunID)
	if err != nil || newSnapshot.Definition.Title != "B" {
		t.Fatalf("новый прогон получает редакцию B: %+v %v", newSnapshot, err)
	}
	header, document, err := store.ReadGraphTemplate(templateID)
	if err != nil || header.Revision != headerB.Revision || !strings.Contains(string(document), `"B"`) {
		t.Fatalf("каталог хранит последнюю принятую редакцию: %s %v", document, err)
	}
}

func TestGraphWorkflowWriteFailureKeepsOldSnapshot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	key := "d11dce6a-b7cc-4654-96b4-3ea48ed46a81"
	digest := strings.Repeat("a", 64)
	created := []byte(`{"format":1,"id":"d11dce6a-b7cc-4654-96b4-3ea48ed46a81","revision":1}`)
	if _, err := store.StartGraphDocument(key, digest, created); err != nil {
		t.Fatal(err)
	}
	workerState := []byte(`{"format":1,"id":"d11dce6a-b7cc-4654-96b4-3ea48ed46a81","revision":2}`)
	failing := func(root *os.Root, name string, data []byte, mode fsMode, replace bool) error {
		return errors.New("отказ диска до rename")
	}
	if err := store.writeGraphDocumentWith(key, digest, 1, workerState, failing); err == nil {
		t.Fatalf("отказ публикации должен вернуться вызывающему")
	}
	reopened := Store{ControlDir: root}
	var observed graphEnvelope
	err := reopened.withGraphWorkflowRoot(false, func(root *os.Root) error {
		found, err := graphEnvelopeAt(root, filepath.Join("runs", key+".json"))
		observed = found
		return err
	})
	if err != nil || observed.Revision != 1 || string(observed.Document) != string(created) {
		t.Fatalf("после отказа до rename читаются прежние байты и ревизия: %+v %v", observed, err)
	}
	if err := reopened.WriteGraphDocument(key, digest, 1, workerState); err != nil {
		t.Fatal(err)
	}
	replay, err := reopened.StartGraphDocument(key, digest, created)
	if err != nil || string(replay) != string(workerState) {
		t.Fatalf("повтор старта после rename получает новый отпечаток без дубликата: %s %v", replay, err)
	}
	err = reopened.withGraphWorkflowRoot(false, func(root *os.Root) error {
		found, err := graphEnvelopeAt(root, filepath.Join("runs", key+".json"))
		observed = found
		return err
	})
	if err != nil || observed.Revision != 2 {
		t.Fatalf("ревизия после принятой записи равна 2: %+v %v", observed, err)
	}
}

func TestGraphWorkflowRefusesSymlinkAndUnknownFormat(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	key := "d11dce6a-b7cc-4654-96b4-3ea48ed46a81"
	digest := strings.Repeat("a", 64)
	created := []byte(`{"format":1,"id":"d11dce6a-b7cc-4654-96b4-3ea48ed46a81","revision":1}`)
	if _, err := store.StartGraphDocument(key, digest, created); err != nil {
		t.Fatal(err)
	}
	targetDir := t.TempDir()
	target := filepath.Join(targetDir, "target.json")
	if err := os.WriteFile(target, created, 0600); err != nil {
		t.Fatal(err)
	}
	runPath := filepath.Join(root, "graph-workflows", "runs", key+".json")
	if err := os.Remove(runPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, runPath); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.ReadGraphRun(key); err == nil {
		t.Fatalf("симлинк из runs должен отклоняться")
	}
	targetBytes, err := os.ReadFile(target)
	if err != nil || string(targetBytes) != string(created) {
		t.Fatalf("байты цели симлинка сохраняются: %s %v", targetBytes, err)
	}
	unknownID := "b1690525-b349-422c-a165-778def939e5c"
	unknown := []byte(`{"format":123,"digest":"` + digest + `","revision":1,"document":{}}`)
	err = store.withGraphWorkflowRoot(true, func(root *os.Root) error {
		return publishFile(root, filepath.Join("runs", unknownID+".json"), unknown, ownerMode, false)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.ReadGraphRun(unknownID); !errors.Is(err, ErrGraphBroken) {
		t.Fatalf("неизвестный формат отклоняется как graph_broken: %v", err)
	}
	var preserved []byte
	err = store.withGraphWorkflowRoot(false, func(root *os.Root) error {
		raw, err := readTrusted(root, filepath.Join("runs", unknownID+".json"), graphDocumentLimit, ownerMode)
		preserved = raw
		return err
	})
	if err != nil || string(preserved) != string(unknown) {
		t.Fatalf("неизвестная запись сохраняется побайтно: %s %v", preserved, err)
	}
}

func TestGraphWorkflowStartReplayAfterTemplateChange(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	runID := "74906bac-48d5-40ce-a6a9-96cbce242146"
	headerA, _, err := store.SaveGraphTemplate(templateID, nil, graphTemplateDoc("A"))
	if err != nil {
		t.Fatal(err)
	}
	request := GraphStartRequest{
		ID: runID, TemplateID: templateID, ExpectedRevision: headerA.Revision,
		Files: []graphInputFile{{Name: "a.txt", Text: "вход"}},
	}
	if _, err := store.StartGraphRun(request, 1000); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.SaveGraphTemplate(templateID, &headerA.Revision, graphTemplateDoc("B")); err != nil {
		t.Fatal(err)
	}
	revision, err := store.StartGraphRun(request, 3000)
	if err != nil || revision != 1 {
		t.Fatalf("повтор принятого старта узнаётся при изменённом шаблоне: %d %v", revision, err)
	}
	found, revision, err := store.StartCheck(request)
	if err != nil || !found || revision != 1 {
		t.Fatalf("start-check видит принятый старт: %v %d %v", found, revision, err)
	}
	changed := request
	changed.Files = []graphInputFile{{Name: "a.txt", Text: "другой"}}
	if _, _, err := store.StartCheck(changed); !errors.Is(err, ErrConflict) {
		t.Fatalf("иной вход с тем же ID конфликтует: %v", err)
	}
	missing := request
	missing.ID = "b1690525-b349-422c-a165-778def939e5c"
	found, _, err = store.StartCheck(missing)
	if err != nil || found {
		t.Fatalf("новый ID не найден без создания записи: %v %v", found, err)
	}
}

func TestGraphWorkflowMutateKeepsRevisionOnNoop(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	runID := "74906bac-48d5-40ce-a6a9-96cbce242146"
	header, _, err := store.SaveGraphTemplate(templateID, nil, graphTemplateDoc("A"))
	if err != nil {
		t.Fatal(err)
	}
	request := GraphStartRequest{
		ID: runID, TemplateID: templateID, ExpectedRevision: header.Revision,
		Files: []graphInputFile{{Name: "a.txt", Text: "вход"}},
	}
	if _, err := store.StartGraphRun(request, 1000); err != nil {
		t.Fatal(err)
	}
	revision, err := store.MutateGraphRun(runID, nil, func(snapshot *graphSnapshot) (bool, error) {
		return false, nil
	})
	if err != nil || revision != 1 {
		t.Fatalf("noop не двигает ревизию: %d %v", revision, err)
	}
	expected := uint64(1)
	revision, err = store.MutateGraphRun(runID, &expected, func(snapshot *graphSnapshot) (bool, error) {
		snapshot.Paused = true
		return true, nil
	})
	if err != nil || revision != 2 {
		t.Fatalf("мутация публикует следующую ревизию: %d %v", revision, err)
	}
	stale := uint64(1)
	if _, err := store.MutateGraphRun(runID, &stale, func(snapshot *graphSnapshot) (bool, error) {
		return true, nil
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("устаревшая ожидаемая ревизия конфликтует: %v", err)
	}
	_, snapshot, err := store.ReadGraphRun(runID)
	if err != nil || !snapshot.Paused {
		t.Fatalf("пауза сохранена в снимке: %+v %v", snapshot, err)
	}
}

const testLeaseMillis = int64(6 * 60 * 1000)

func graphParallelTemplate(leaves int) []byte {
	steps := `{"id":"src","title":"Источник","kind":"input"}`
	needs := ""
	for index := 1; index <= leaves; index++ {
		leaf := string(rune('a' + index - 1))
		steps += `,{"id":"` + leaf + `","title":"` + leaf + `","kind":"agent","needs":["src"],"prompt":"сделай"}`
		if needs != "" {
			needs += ","
		}
		needs += `"` + leaf + `"`
	}
	steps += `,{"id":"out","title":"Сборка","kind":"join","mode":"all","needs":[` + needs + `]}`
	return []byte(`{"title":"Параллель","inputKind":"documents","scope":{"returns":["out"],"steps":[` + steps + `]}}`)
}

func graphStartParallel(t *testing.T, store Store, templateID, runID string, leaves int, createdAt int64) {
	t.Helper()
	header, _, err := store.SaveGraphTemplate(templateID, nil, graphParallelTemplate(leaves))
	if err != nil {
		t.Fatal(err)
	}
	request := GraphStartRequest{
		ID: runID, TemplateID: templateID, ExpectedRevision: header.Revision,
		Files: []graphInputFile{{Name: "a.txt", Text: "вход"}},
	}
	if _, err := store.StartGraphRun(request, createdAt); err != nil {
		t.Fatal(err)
	}
}

func TestGraphWorkflowClaimSettleIndependentRevisions(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	runID := "74906bac-48d5-40ce-a6a9-96cbce242146"
	graphStartParallel(t, store, templateID, runID, 2, 1000)

	first, err := store.ClaimGraphJob(1000)
	if err != nil || first.Job == nil || first.Job.NodeID != "a" {
		t.Fatalf("первая выдача принимает лист a: %+v %v", first, err)
	}
	second, err := store.ClaimGraphJob(1000)
	if err != nil || second.Job == nil || second.Job.NodeID != "b" {
		t.Fatalf("вторая выдача принимает лист b независимо: %+v %v", second, err)
	}
	if _, err := store.SettleGraphJob(graphworkflow.Settlement{
		RunID: runID, NodeID: "b", Generation: 1, ClaimID: second.Job.ClaimID,
		Rows: []graphworkflow.Row{{Key: "rb", Title: "B", Text: "готово B"}},
	}, 1100); err != nil {
		t.Fatalf("завершение второй выдачи принимается: %v", err)
	}
	if _, err := store.SettleGraphJob(graphworkflow.Settlement{
		RunID: runID, NodeID: "a", Generation: 1, ClaimID: first.Job.ClaimID,
		Rows: []graphworkflow.Row{{Key: "ra", Title: "A", Text: "готово A"}},
	}, 1200); err != nil {
		t.Fatalf("независимое завершение первой выдачи не зависит от head ревизии: %v", err)
	}
	_, snapshot, err := store.ReadGraphRun(runID)
	if err != nil || snapshot.Status() != "done" {
		t.Fatalf("оба результата приняты, сборка завершена: %+v %v", snapshot, err)
	}
}

func TestGraphWorkflowParallelClaimAndRecovery(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	storeA := Store{ControlDir: root}
	storeB := Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	run1 := "74906bac-48d5-40ce-a6a9-96cbce242146"
	run2 := "b1690525-b349-422c-a165-778def939e5c"
	run3 := "5f820c44-a351-4932-949c-4b970e81dbc8"
	header, _, err := storeA.SaveGraphTemplate(templateID, nil, graphParallelTemplate(3))
	if err != nil {
		t.Fatal(err)
	}
	for index, id := range []string{run1, run2, run3} {
		request := GraphStartRequest{
			ID: id, TemplateID: templateID, ExpectedRevision: header.Revision,
			Files: []graphInputFile{{Name: "a.txt", Text: "вход"}},
		}
		if _, err := storeA.StartGraphRun(request, int64(1000*(index+1))); err != nil {
			t.Fatal(err)
		}
	}

	claims := make([]GraphClaimResult, 0, 5)
	for index := 0; index < 5; index++ {
		store := storeA
		if index%2 == 1 {
			store = storeB
		}
		claim, err := store.ClaimGraphJob(1000)
		if err != nil {
			t.Fatal(err)
		}
		claims = append(claims, claim)
	}
	for index, want := range []string{run1, run1, run1, run2, run2} {
		if job := claims[index].Job; job == nil || job.ID != want {
			t.Fatalf("выдача %d не должна ждать прежние лимиты: %+v", index+1, job)
		}
	}

	fresh := Store{ControlDir: root}
	expired, err := fresh.ClaimGraphJob(1000 + testLeaseMillis)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{run1, run2} {
		_, snapshot, err := fresh.ReadGraphRun(id)
		if err != nil {
			t.Fatal(err)
		}
		for _, leaf := range []string{"a", "b"} {
			node := snapshot.Nodes[leaf]
			if node.Status != "failed" || node.ErrorCode != "interrupted" {
				t.Fatalf("лист %s.%s прерван по lease: %+v", id, leaf, node)
			}
		}
	}
	if expired.Job == nil || expired.Job.ID != run2 || expired.Job.NodeID != "c" {
		t.Fatalf("после истечения выдач берётся ранний готовый лист: %+v", expired)
	}

	_, snapshot, err := fresh.ReadGraphRun(run1)
	if err != nil {
		t.Fatal(err)
	}
	generation := snapshot.Nodes["a"].Generation
	_, err = fresh.ActionGraphRun(run1, graphRevisionOf(t, fresh, run1), "a", generation, "retry", "", "", 1000+testLeaseMillis+10)
	if err != nil {
		t.Fatalf("повтор прерванного листа принимается: %v", err)
	}
	_, retried, err := fresh.ReadGraphRun(run1)
	if err != nil || retried.Nodes["a"].Generation != generation+1 || retried.Nodes["a"].Status != "ready" {
		t.Fatalf("повтор создаёт новое поколение готового листа: %+v %v", retried.Nodes["a"], err)
	}
	if retried.Nodes["b"].Generation != 1 {
		t.Fatalf("сестринский лист не пересчитывается: %+v", retried.Nodes["b"])
	}
	if _, err := fresh.SettleGraphJob(graphworkflow.Settlement{
		RunID: run1, NodeID: "a", Generation: generation, ClaimID: claims[0].Job.ClaimID,
		Rows: []graphworkflow.Row{{Key: "late", Title: "Поздний", Text: "устарел"}},
	}, 1000+testLeaseMillis+20); !errors.Is(err, graphworkflow.ErrStaleClaim) {
		t.Fatalf("поздний токен отвергается: %v", err)
	}
	_, independent, err := fresh.ReadGraphRun(run3)
	if err != nil || independent.Nodes["c"].Status != "ready" {
		t.Fatalf("независимая запись сохраняет свои результаты: %+v %v", independent, err)
	}
}

func graphRevisionOf(t *testing.T, store Store, id string) uint64 {
	t.Helper()
	var revision uint64
	err := store.withGraphWorkflowRoot(false, func(root *os.Root) error {
		value, err := graphEnvelopeAt(root, filepath.Join("runs", id+".json"))
		revision = value.Revision
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return revision
}

func TestGraphWorkflowResumesWithinSharedCapacity(t *testing.T) {
	store := Store{ControlDir: filepath.Join(t.TempDir(), "control")}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	doc := []byte(`{"title":"Проверка","inputKind":"documents","scope":{"returns":["gate"],"steps":[
		{"id":"src","title":"Вход","kind":"input"},
		{"id":"gate","title":"Ворота","kind":"approval","needs":["src"]}]}}`)
	header, _, err := store.SaveGraphTemplate(templateID, nil, doc)
	if err != nil {
		t.Fatal(err)
	}
	request := GraphStartRequest{TemplateID: templateID, ExpectedRevision: header.Revision,
		Files: []graphInputFile{{Name: "test.txt", Text: "Синтетический документ"}}}
	pausedID := "74906bac-48d5-40ce-a6a9-96cbce242146"
	request.ID = pausedID
	if _, err := store.StartGraphRun(request, 1000); err != nil {
		t.Fatal(err)
	}
	paused, err := store.ActionGraphRun(pausedID, 1, "", 0, "pause", "", "", 1001)
	if err != nil {
		t.Fatal(err)
	}
	for i := range graphActiveLimit {
		request.ID = fmt.Sprintf("00000000-2222-4444-8888-%012d", i)
		if _, err := store.StartGraphRun(request, 2000+int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.ActionGraphRun(pausedID, paused.Revision, "", 0, "resume", "", "", 3000); !errors.Is(err, errGraphActiveLimit) {
		t.Fatalf("возобновление при полном индексе: %v", err)
	}
	envelope, snapshot, err := store.ReadGraphRun(pausedID)
	if err != nil || snapshot.Status() != "paused" || envelope.Revision != paused.Revision {
		t.Fatalf("пауза должна сохраниться: %v %v", snapshot, err)
	}
	if _, err := store.ClaimGraphJob(3100); err != nil {
		t.Fatalf("опрос общего индекса: %v", err)
	}
	if _, err := store.ActionGraphRun(request.ID, 1, "gate", 1, "approve", "", "", 3200); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ActionGraphRun(pausedID, paused.Revision, "", 0, "resume", "", "", 3300); err != nil {
		t.Fatalf("возобновление после освобождения места: %v", err)
	}
}

func TestGraphWorkflowRepairsStartBetweenHeaderAndSnapshot(t *testing.T) {
	store := Store{ControlDir: filepath.Join(t.TempDir(), "control")}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	request := GraphStartRequest{
		ID: "74906bac-48d5-40ce-a6a9-96cbce242146", TemplateID: templateID,
		Files: []graphInputFile{{Name: "test.txt", Text: "Синтетический вход"}},
	}
	doc := []byte(`{"title":"Старт","inputKind":"documents","scope":{"returns":["src"],
		"steps":[{"id":"src","title":"Вход","kind":"input"}]}}`)
	header, _, err := store.SaveGraphTemplate(templateID, nil, doc)
	if err != nil {
		t.Fatal(err)
	}
	request.ExpectedRevision = header.Revision
	if _, err := store.StartGraphRun(request, 1000); err != nil {
		t.Fatal(err)
	}
	err = store.withGraphWorkflowRoot(true, func(root *os.Root) error {
		return root.Remove(filepath.Join("runs", request.ID+".json"))
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartGraphRun(request, 2000); err != nil {
		t.Fatal(err)
	}
	history, _, err := store.ListGraphRuns("")
	if err != nil || len(history) != 1 || history[0].ID != request.ID || history[0].Status != "done" {
		t.Fatalf("повтор восстанавливает один прогон: %v %v", history, err)
	}
}
