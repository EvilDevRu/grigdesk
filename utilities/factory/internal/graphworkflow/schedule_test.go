package graphworkflow

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestJoinPicksFirstAcceptedSuccessAndTracksQuorum(t *testing.T) {
	needs := []Dependency{
		{ID: "left", Status: "running", Generation: 1},
		{ID: "middle", Status: "done", Generation: 2, AcceptedAt: 3},
		{ID: "right", Status: "done", Generation: 1, AcceptedAt: 2},
	}
	first := chooseDependencies("any", 0, needs)
	if !first.Ready || first.Blocked || !reflect.DeepEqual(first.Selected, []ResultRef{{"right", 1}}) {
		t.Fatalf("ожидали первый принятый результат right, получили %+v", first)
	}
	quorum := chooseDependencies("quorum", 2, needs)
	want := []ResultRef{{"right", 1}, {"middle", 2}}
	if !quorum.Ready || !reflect.DeepEqual(quorum.Selected, want) {
		t.Fatalf("кворум должен состоять из %v, получено %+v", want, quorum)
	}
	needs[0].Status = "failed"
	needs[1].Status = "skipped"
	missing := chooseDependencies("quorum", 2, needs)
	if !missing.Blocked || missing.Ready {
		t.Fatalf("недостижимый кворум должен быть явно закрыт: %+v", missing)
	}
	all := chooseDependencies("all", 0, needs[1:])
	if !all.Ready || len(all.Selected) != 1 || all.Selected[0].ID != "right" {
		t.Fatalf("пропущенный условный вход не должен блокировать all: %+v", all)
	}
}

func TestExpandKeepsBothSectionsAndDoesNotPublishPartialGroup(t *testing.T) {
	def := Definition{
		Title: "Документы", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"out"},
			Steps: []Step{
				{ID: "list", Title: "Список", Kind: "input"},
				{
					ID: "files", Title: "Документы", Kind: "forEach", Source: "list", Needs: []string{"list"},
					Scope: &Scope{
						Returns: []string{"summary"},
						Steps: []Step{
							{ID: "summary", Title: "Сводка файла", Kind: "agent", Reads: []string{"$item"}, Prompt: "кратко"},
						},
					},
				},
				{ID: "out", Title: "Сборка", Kind: "join", Mode: "all", Needs: []string{"files"}},
			},
		},
	}
	run := NewRun(def, []Row{{Key: "file-1", Title: "a", Text: "один"}, {Key: "file-2", Title: "b", Text: "два"}})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"files.1.summary", "files.2.summary"} {
		if node, found := run.Nodes[id]; !found || node.Status != "ready" {
			t.Fatalf("материализованный %s должен иметь статус ready, получили %+v", id, node)
		}
	}
	if node := run.Nodes["out"]; node.Status != "pending" || len(node.Selected) != 0 {
		t.Fatalf("сборка должна ждать обе ветки: %+v", node)
	}
	before := len(run.Nodes)
	if err := run.Advance(); err != nil || len(run.Nodes) != before {
		t.Fatalf("повторный расчёт породил дубли: %v, было %d стало %d", err, before, len(run.Nodes))
	}
}

// assertStatus читает фактический статус экземпляра, не вычисляя ожидаемое решение.
func assertStatus(t *testing.T, run *Snapshot, id, want string) {
	t.Helper()
	node := run.Nodes[id]
	if node == nil {
		t.Fatalf("узел %s отсутствует, ожидали статус %s", id, want)
	}
	if node.Status != want {
		t.Fatalf("узел %s: ожидали %s, получили %s (errorCode=%s)", id, want, node.Status, node.ErrorCode)
	}
}

// applyFixtureCompletion принимает результат готового узла как хост с номером clock.
// Токены и lease реально проверяются на шаге 4, здесь только планировщик.
func applyFixtureCompletion(t *testing.T, run *Snapshot, id string, rows []Row) {
	t.Helper()
	node := run.Nodes[id]
	if node == nil || node.Status != "ready" {
		t.Fatalf("узел %s не готов к принятию результата: %+v", id, node)
	}
	node.Claim = nil
	node.Rows = rows
	run.Clock++
	node.AcceptedAt = run.Clock
	node.Status = "done"
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
}

// applyFixtureFailure завершает готовый или работающий узел отказом без модельного выхода.
func applyFixtureFailure(t *testing.T, run *Snapshot, id, code string) {
	t.Helper()
	node := run.Nodes[id]
	if node == nil || (node.Status != "ready" && node.Status != "running") {
		t.Fatalf("узел %s не готов к отказу: %+v", id, node)
	}
	node.Claim = nil
	node.Status = "failed"
	node.ErrorCode = code
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
}

func inputRow(key, text string) Row {
	return Row{Key: key, Title: key, Text: text, Sources: []SourceRef{{InputKey: key, Line: 1}}}
}

func TestExpandNestedAndEmpty(t *testing.T) {
	def := Definition{
		Title: "Вложенные", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"out"},
			Steps: []Step{
				{ID: "list", Title: "Список", Kind: "input"},
				{ID: "files", Title: "Документы", Kind: "forEach", Source: "list", Needs: []string{"list"},
					Scope: &Scope{
						Returns: []string{"sections"},
						Steps: []Step{
							{ID: "split", Title: "Разделы", Kind: "sections", Reads: []string{"$item"}},
							{ID: "sections", Title: "По разделу", Kind: "forEach", Source: "split", Needs: []string{"split"},
								Scope: &Scope{
									Returns: []string{"work"},
									Steps: []Step{
										{ID: "work", Title: "Работа", Kind: "agent", Reads: []string{"$item"}, Prompt: "сделай"},
									},
								}},
						},
					}},
				{ID: "out", Title: "Сборка", Kind: "join", Mode: "all", Needs: []string{"files"}},
			},
		},
	}
	run := NewRun(def, []Row{
		inputRow("file-1", "# A\nодин\n# B\nдва"),
		inputRow("file-2", ""),
	})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, run, "files.1.sections.1.work", "ready")
	assertStatus(t, run, "files.1.sections.2.work", "ready")
	assertStatus(t, run, "files.2.sections", "done")
	emptyRefs, err := run.RowsRefsFor(ResultRef{ID: "files.2.sections", Generation: 1})
	if err != nil || len(emptyRefs) != 0 {
		t.Fatalf("пустая группа должна завершиться с нулём строк: %v %v", emptyRefs, err)
	}
	assertStatus(t, run, "out", "pending")
	firstRows, err := run.RowsFor(ResultRef{ID: "files.1.sections.1.work", Generation: 1}, claimRowsLimit)
	if err != nil || len(firstRows) != 1 || firstRows[0].Sources[0].Line != 1 {
		t.Fatalf("первый лист читает раздел со строки 1: %+v %v", firstRows, err)
	}
	secondRows, err := run.RowsFor(ResultRef{ID: "files.1.sections.2.work", Generation: 1}, claimRowsLimit)
	if err != nil || len(secondRows) != 1 || secondRows[0].Sources[0].Line != 3 {
		t.Fatalf("второй лист читает раздел со строки 3: %+v %v", secondRows, err)
	}
	applyFixtureCompletion(t, run, "files.1.sections.2.work", []Row{{Key: "w2", Title: "B", Text: "готово B"}})
	assertStatus(t, run, "out", "pending")
	applyFixtureCompletion(t, run, "files.1.sections.1.work", []Row{{Key: "w1", Title: "A", Text: "готово A"}})
	assertStatus(t, run, "out", "done")
	rows, err := run.RowsFor(ResultRef{ID: "out", Generation: 1}, joinOutputLimit)
	if err != nil || len(rows) != 2 {
		t.Fatalf("сборка принимает два реальных результата: %+v %v", rows, err)
	}
}

func TestForEachParallelismKeepsAnElementUntilItsSubrouteFinishes(t *testing.T) {
	definition := Definition{
		Title: "Ветки", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"files"},
			Steps: []Step{
				{ID: "list", Title: "Источник", Kind: "input"},
				{ID: "files", Title: "Ветки", Kind: "forEach", Source: "list", Needs: []string{"list"},
					Parallelism: 2, Mode: "any",
					Scope: &Scope{Returns: []string{"review"}, Steps: []Step{
						{ID: "scan", Title: "Разбор", Kind: "agent", Reads: []string{"$item"}, Prompt: "разбери"},
						{ID: "review", Title: "Проверка", Kind: "call", Needs: []string{"scan"},
							Scope: &Scope{Returns: []string{"finish"}, Steps: []Step{
								{ID: "finish", Title: "Проверка", Kind: "agent", Prompt: "проверь"},
							}}},
					}}},
			},
		},
	}
	inputs := []Row{inputRow("a", "A"), inputRow("b", "B"), inputRow("c", "C"), inputRow("d", "D")}
	run := NewRun(definition, inputs)
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, run, "files.1.scan", "ready")
	assertStatus(t, run, "files.2.scan", "ready")
	assertStatus(t, run, "files.3.scan", "pending")

	applyFixtureCompletion(t, run, "files.1.scan", []Row{})
	assertStatus(t, run, "files.1.review.1.finish", "ready")
	assertStatus(t, run, "files.3.scan", "pending")

	encoded, err := json.Marshal(run)
	if err != nil {
		t.Fatal(err)
	}
	run = new(Snapshot)
	if err := json.Unmarshal(encoded, run); err != nil {
		t.Fatal(err)
	}
	applyFixtureFailure(t, run, "files.1.review.1.finish", "run_failed")
	assertStatus(t, run, "files.3.scan", "ready")
	assertStatus(t, run, "files.4.scan", "pending")

	if err := run.Retry("files.1.review.1.finish"); err != nil {
		t.Fatal(err)
	}
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, run, "files.1.review.1.finish", "pending")
	applyFixtureCompletion(t, run, "files.2.scan", []Row{})
	applyFixtureCompletion(t, run, "files.2.review.1.finish", []Row{})
	assertStatus(t, run, "files", "done")
	assertStatus(t, run, "files.1.review.1.finish", "ready")
	assertStatus(t, run, "files.4.scan", "pending")
	applyFixtureCompletion(t, run, "files.1.review.1.finish", []Row{})
	assertStatus(t, run, "files.4.scan", "ready")
}

func TestExpandLimitDoesNotLeaveChildren(t *testing.T) {
	def := Definition{
		Title: "Предел", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"out"},
			Steps: []Step{
				{ID: "list", Title: "Список", Kind: "input"},
				{ID: "files", Title: "Документы", Kind: "forEach", Source: "list", Needs: []string{"list"},
					Scope: &Scope{Returns: []string{"summary"}, Steps: []Step{
						{ID: "summary", Title: "Сводка", Kind: "agent", Reads: []string{"$item"}, Prompt: "кратко"},
					}}},
				{ID: "out", Title: "Сборка", Kind: "join", Mode: "all", Needs: []string{"files"}},
			},
		},
	}
	inputs := make([]Row, 0, maxInstances)
	for index := 1; index <= maxInstances; index++ {
		inputs = append(inputs, inputRow(fmt.Sprintf("file-%d", index), "текст"))
	}
	run := NewRun(def, inputs)
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	issued := run.Issued
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, run, "files", "failed")
	if run.Nodes["files"].ErrorCode != "node_limit" {
		t.Fatalf("ожидали node_limit, получили %s", run.Nodes["files"].ErrorCode)
	}
	for id := range run.Nodes {
		if strings.HasPrefix(id, "files.") {
			t.Fatalf("после отказа бюджета не должно быть дочерних ID, найден %s", id)
		}
	}
	if run.Issued != issued || issued != 3 {
		t.Fatalf("issued не должен меняться при отказе бюджета: %d", run.Issued)
	}
	assertStatus(t, run, "out", "blocked")
}

func TestJoinKeepsEarlyInput(t *testing.T) {
	def := Definition{
		Title: "Ранняя сборка", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"out"},
			Steps: []Step{
				{ID: "src", Title: "Источник", Kind: "input"},
				{ID: "left", Title: "Левый", Kind: "agent", Needs: []string{"src"}, Prompt: "лево"},
				{ID: "right", Title: "Правый", Kind: "agent", Needs: []string{"src"}, Prompt: "право"},
				{ID: "out", Title: "Сборка", Kind: "join", Mode: "any", Needs: []string{"left", "right"}},
			},
		},
	}
	run := NewRun(def, []Row{inputRow("file-1", "вход")})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	applyFixtureCompletion(t, run, "right", []Row{{Key: "r", Title: "Правый", Text: "один"}})
	assertStatus(t, run, "out", "done")
	out := run.Nodes["out"]
	if !reflect.DeepEqual(out.Selected, []ResultRef{{ID: "right", Generation: 1}}) {
		t.Fatalf("any закрепляет первый принятый результат: %+v", out.Selected)
	}
	accepted := out.AcceptedAt
	applyFixtureCompletion(t, run, "left", []Row{{Key: "l", Title: "Левый", Text: "два"}})
	if !reflect.DeepEqual(run.Nodes["out"].Selected, []ResultRef{{ID: "right", Generation: 1}}) {
		t.Fatalf("поздний результат не меняет выборку: %+v", run.Nodes["out"].Selected)
	}
	rows, err := run.RowsFor(ResultRef{ID: "out", Generation: 1}, joinOutputLimit)
	if err != nil || len(rows) != 1 || rows[0].Text != "один" {
		t.Fatalf("выход сборки остаётся «один»: %+v %v", rows, err)
	}
	if run.Nodes["out"].AcceptedAt != accepted {
		t.Fatalf("номер принятия сборки не должен меняться")
	}
}

func TestDecisionRejectReopensDependentsOnly(t *testing.T) {
	def := Definition{
		Title: "Возврат", InputKind: "transcript",
		Scope: Scope{
			Returns: []string{"review"},
			Steps: []Step{
				{ID: "src", Title: "Источник", Kind: "input"},
				{ID: "decisions", Title: "Протокол", Kind: "agent", Needs: []string{"src"}, Prompt: "протокол"},
				{ID: "tasks", Title: "Поручения", Kind: "agent", Needs: []string{"src"}, Prompt: "поручения"},
				{ID: "summary", Title: "Сводка", Kind: "join", Mode: "all", Needs: []string{"decisions", "tasks"}},
				{ID: "review", Title: "Ворота", Kind: "approval", Needs: []string{"summary"}, RetryFrom: RetryTarget{"tasks"}},
			},
		},
	}
	run := NewRun(def, []Row{inputRow("file-1", "реплика")})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	applyFixtureCompletion(t, run, "decisions", []Row{{Key: "d", Title: "Решение", Text: "принято"}})
	applyFixtureCompletion(t, run, "tasks", []Row{{Key: "t", Title: "Поручение", Text: "сделать"}})
	assertStatus(t, run, "review", "waiting")
	if err := run.Decide("review", 1, false, "tasks", "проверь ответственного"); err != nil {
		t.Fatal(err)
	}
	if run.Nodes["tasks"].Generation <= 1 || run.Nodes["tasks"].Status != "pending" {
		t.Fatalf("ветка поручений должна пересчитаться с новой generation: %+v", run.Nodes["tasks"])
	}
	if run.Nodes["tasks"].Feedback != "проверь ответственного" {
		t.Fatalf("замечание сохраняется у пересчитываемого модельного узла")
	}
	if run.Nodes["decisions"].Generation != 1 || run.Nodes["decisions"].Status != "done" {
		t.Fatalf("независимая ветка решений сохраняется: %+v", run.Nodes["decisions"])
	}
	if run.Nodes["review"].Status == "waiting" || run.Nodes["review"].Generation <= 1 {
		t.Fatalf("старое согласование аннулировано: %+v", run.Nodes["review"])
	}
	for _, view := range run.PreviewResult().Approvals {
		if view.NodeID == "review" {
			t.Fatalf("прежнее решение не должно присутствовать в текущей сводке: %+v", view)
		}
	}
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	applyFixtureCompletion(t, run, "tasks", []Row{{Key: "t2", Title: "Поручение", Text: "сделать иначе"}})
	assertStatus(t, run, "review", "waiting")
	if run.Nodes["review"].Generation != 2 {
		t.Fatalf("ворота ожидают решения нового поколения: %+v", run.Nodes["review"])
	}
}

func TestDynamicQuorumUsesCompletedItems(t *testing.T) {
	def := Definition{
		Title: "Кворум", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"report"},
			Steps: []Step{
				{ID: "list", Title: "Список", Kind: "input"},
				{ID: "files", Title: "Документы", Kind: "forEach", Source: "list", Needs: []string{"list"},
					Mode: "quorum", MinSuccess: 2,
					Scope: &Scope{Returns: []string{"a"}, Steps: []Step{
						{ID: "a", Title: "Работа", Kind: "agent", Reads: []string{"$item"}, Prompt: "сделай"},
					}}},
				{ID: "report", Title: "Сборка", Kind: "join", Mode: "all", Needs: []string{"files"}},
			},
		},
	}
	run := NewRun(def, []Row{inputRow("file-1", "один"), inputRow("file-2", "два"), inputRow("file-3", "три")})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	run.Nodes["files.1.a"].Status = "running"
	applyFixtureCompletion(t, run, "files.2.a", []Row{{Key: "r2", Title: "Второй", Text: "готово 2"}})
	applyFixtureCompletion(t, run, "files.3.a", []Row{{Key: "r3", Title: "Третий", Text: "готово 3"}})
	assertStatus(t, run, "files", "done")
	assertStatus(t, run, "report", "done")
	want := []ResultRef{{ID: "files.2.a", Generation: 1}, {ID: "files.3.a", Generation: 1}}
	if !reflect.DeepEqual(run.Nodes["files"].Selected, want) {
		t.Fatalf("кворум выбирает два завершённых выхода: %+v", run.Nodes["files"].Selected)
	}
	if run.Status() != "running" {
		t.Fatalf("третий лист ещё работает, прогон running: %s", run.Status())
	}
	applyFixtureFailure(t, run, "files.1.a", "run_failed")
	if !reflect.DeepEqual(run.Nodes["files"].Selected, want) {
		t.Fatalf("поздний отказ не меняет закреплённую выборку: %+v", run.Nodes["files"].Selected)
	}
	if run.Status() != "done" {
		t.Fatalf("после позднего отказа прогон завершён: %s", run.Status())
	}
	missing := run.PreviewResult().Missing
	found := false
	for _, item := range missing {
		if item.NodeID == "files.1.a" && item.ErrorCode == "run_failed" {
			found = true
		}
	}
	if !found {
		t.Fatalf("сводка показывает поздний отказ: %+v", missing)
	}
}

func TestSubflowReceivesFrozenArguments(t *testing.T) {
	scope := &Scope{Returns: []string{"work"}, Steps: []Step{
		{ID: "work", Title: "Работа", Kind: "agent", Reads: []string{"$inputs"}, Prompt: "сделай"},
	}}
	def := Definition{
		Title: "Аргументы", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"sub"},
			Steps: []Step{
				{ID: "raw", Title: "Источник", Kind: "input"},
				{ID: "normalized", Title: "Норма", Kind: "agent", Needs: []string{"raw"}, Prompt: "нормализуй"},
				{ID: "sub", Title: "Подмаршрут", Kind: "call", Needs: []string{"normalized"},
					Reads: []string{"normalized"}, Scope: scope},
			},
		},
	}
	run := NewRun(def, []Row{inputRow("file-1", "исходник")})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	normalizedRows := []Row{{Key: "n1", Title: "Норма", Text: "нормализовано"}}
	applyFixtureCompletion(t, run, "normalized", normalizedRows)
	assertStatus(t, run, "sub.1.work", "ready")
	rows, err := run.RowsFor(ResultRef{ID: "sub.1.work", Generation: 1}, claimRowsLimit)
	if err != nil || !reflect.DeepEqual(rows, normalizedRows) {
		t.Fatalf("call получает точный результат normalized: %+v %v", rows, err)
	}
	defRepeat := Definition{
		Title: "Аргументы repeat", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"cycle"},
			Steps: []Step{
				{ID: "raw", Title: "Источник", Kind: "input"},
				{ID: "normalized", Title: "Норма", Kind: "agent", Needs: []string{"raw"}, Prompt: "нормализуй"},
				{ID: "cycle", Title: "Цикл", Kind: "repeat", Needs: []string{"normalized"},
					Reads: []string{"normalized"}, MaxRounds: 2, Scope: scope},
			},
		},
	}
	repeatRun := NewRun(defRepeat, []Row{inputRow("file-1", "исходник")})
	if err := repeatRun.Advance(); err != nil {
		t.Fatal(err)
	}
	applyFixtureCompletion(t, repeatRun, "normalized", normalizedRows)
	repeatRows, err := repeatRun.RowsFor(ResultRef{ID: "cycle.1.work", Generation: 1}, claimRowsLimit)
	if err != nil || !reflect.DeepEqual(repeatRows, normalizedRows) {
		t.Fatalf("repeat наследует замороженный аргумент: %+v %v", repeatRows, err)
	}
}

func TestDecisionRepeatProducesNewRound(t *testing.T) {
	def := Definition{
		Title: "Цикл", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"cycle"},
			Steps: []Step{
				{ID: "src", Title: "Источник", Kind: "input"},
				{ID: "cycle", Title: "Повтор", Kind: "repeat", Needs: []string{"src"}, MaxRounds: 2,
					Scope: &Scope{Returns: []string{"check"}, Steps: []Step{
						{ID: "check", Title: "Проверка", Kind: "agent", Reads: []string{"$inputs"}, Prompt: "проверь"},
					}}},
			},
		},
	}
	run := NewRun(def, []Row{inputRow("file-1", "вход")})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, run, "cycle.1.check", "ready")
	applyFixtureCompletion(t, run, "cycle.1.check", []Row{})
	assertStatus(t, run, "cycle.2.check", "ready")
	final := []Row{{Key: "ok", Title: "Найдено", Text: "строка"}}
	applyFixtureCompletion(t, run, "cycle.2.check", final)
	assertStatus(t, run, "cycle", "done")
	if !reflect.DeepEqual(run.Nodes["cycle"].Selected, []ResultRef{{ID: "cycle.2.check", Generation: 1}}) {
		t.Fatalf("принимается только непустой круг: %+v", run.Nodes["cycle"].Selected)
	}
	rows, err := run.RowsFor(ResultRef{ID: "cycle", Generation: 1}, joinOutputLimit)
	if err != nil || !reflect.DeepEqual(rows, final) {
		t.Fatalf("выход цикла — результат второго круга: %+v %v", rows, err)
	}
	exhausted := NewRun(def, []Row{inputRow("file-1", "вход")})
	if err := exhausted.Advance(); err != nil {
		t.Fatal(err)
	}
	applyFixtureCompletion(t, exhausted, "cycle.1.check", []Row{})
	applyFixtureCompletion(t, exhausted, "cycle.2.check", []Row{})
	assertStatus(t, exhausted, "cycle", "failed")
	if exhausted.Nodes["cycle"].ErrorCode != "repeat_exhausted" {
		t.Fatalf("два пустых круга дают repeat_exhausted: %s", exhausted.Nodes["cycle"].ErrorCode)
	}
}

func TestDecisionConditionRejectsFalseBranch(t *testing.T) {
	def := Definition{
		Title: "Условия", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"out"},
			Steps: []Step{
				{ID: "items", Title: "Список", Kind: "input"},
				{ID: "ifAdded", Title: "Если есть", Kind: "agent", Needs: []string{"items"},
					When: &Condition{Source: "items", Test: "nonempty"}, Prompt: "обработай"},
				{ID: "ifEmpty", Title: "Если пусто", Kind: "agent", Needs: []string{"items"},
					When: &Condition{Source: "items", Test: "empty"}, Prompt: "сообщи"},
				{ID: "out", Title: "Сборка", Kind: "join", Mode: "all", Needs: []string{"ifAdded", "ifEmpty"}},
			},
		},
	}
	run := NewRun(def, []Row{})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, run, "ifAdded", "skipped")
	assertStatus(t, run, "ifEmpty", "ready")
	applyFixtureCompletion(t, run, "ifEmpty", []Row{{Key: "e", Title: "Пусто", Text: "список пуст"}})
	assertStatus(t, run, "out", "done")
}

func TestDecisionConditionBlocksOnFailedSource(t *testing.T) {
	def := Definition{
		Title: "Отказ условия", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"out"},
			Steps: []Step{
				{ID: "src", Title: "Источник", Kind: "input"},
				{ID: "items", Title: "Список", Kind: "agent", Needs: []string{"src"}, Prompt: "получи"},
				{ID: "ifAdded", Title: "Если есть", Kind: "agent", Needs: []string{"items"},
					When: &Condition{Source: "items", Test: "nonempty"}, Prompt: "обработай"},
				{ID: "out", Title: "Сборка", Kind: "join", Mode: "all", Needs: []string{"ifAdded"}},
			},
		},
	}
	run := NewRun(def, []Row{inputRow("file-1", "вход")})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	applyFixtureFailure(t, run, "items", "run_failed")
	assertStatus(t, run, "ifAdded", "blocked")
	assertStatus(t, run, "out", "blocked")
	if run.Status() == "done" {
		t.Fatalf("прогон с заблокированной обязательной веткой не завершается успешно")
	}
}

func TestDecisionResultSizeUsesRealRows(t *testing.T) {
	steps := []Step{{ID: "src", Title: "Источник", Kind: "input"}}
	needs := make([]string, 0, 9)
	for index := 1; index <= 9; index++ {
		id := fmt.Sprintf("a%d", index)
		steps = append(steps, Step{ID: id, Title: id, Kind: "agent", Needs: []string{"src"}, Prompt: "сделай"})
		needs = append(needs, id)
	}
	steps = append(steps, Step{ID: "out", Title: "Сборка", Kind: "join", Mode: "all", Needs: needs})
	def := Definition{Title: "Объём", InputKind: "documents", Scope: Scope{Returns: []string{"out"}, Steps: steps}}
	run := NewRun(def, []Row{inputRow("file-1", "вход")})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	for index := 1; index <= 9; index++ {
		id := fmt.Sprintf("a%d", index)
		applyFixtureCompletion(t, run, id, []Row{{Key: id, Title: id, Text: strings.Repeat("a", 15*1024)}})
	}
	assertStatus(t, run, "out", "failed")
	if run.Nodes["out"].ErrorCode != "output_limit" {
		t.Fatalf("сборка отказывает по фактическому объёму: %s", run.Nodes["out"].ErrorCode)
	}
	for index := 1; index <= 9; index++ {
		id := fmt.Sprintf("a%d", index)
		rows, err := run.RowsFor(ResultRef{ID: id, Generation: 1}, claimRowsLimit)
		if err != nil || len(rows) != 1 || len(rows[0].Text) != 15*1024 {
			t.Fatalf("готовый лист %s читается по ID после отказа сборки: %v", id, err)
		}
	}
}

func TestJoinAndApprovalReadDeclaredRows(t *testing.T) {
	def := Definition{
		Title: "Чтение", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"review"},
			Steps: []Step{
				{ID: "raw", Title: "Сырьё", Kind: "input"},
				{ID: "normalized", Title: "Норма", Kind: "agent", Needs: []string{"raw"}, Prompt: "нормализуй"},
				{ID: "review", Title: "Ворота", Kind: "approval", Needs: []string{"raw", "normalized"},
					Reads: []string{"normalized"}},
			},
		},
	}
	run := NewRun(def, []Row{inputRow("file-1", "сырьё")})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	normalizedRows := []Row{{Key: "n", Title: "Норма", Text: "нормализовано"}}
	applyFixtureCompletion(t, run, "normalized", normalizedRows)
	assertStatus(t, run, "review", "waiting")
	rows, err := run.RowsFor(ResultRef{ID: "review", Generation: 1}, joinOutputLimit)
	if err != nil || !reflect.DeepEqual(rows, normalizedRows) {
		t.Fatalf("ворота читают только объявленный normalized: %+v %v", rows, err)
	}
	preview := run.PreviewResult()
	if !reflect.DeepEqual(preview.Rows, normalizedRows) {
		t.Fatalf("сводка и ворота читают одни данные: %+v", preview.Rows)
	}
	defEmpty := def
	defEmpty.Scope.Steps = append([]Step(nil), def.Scope.Steps...)
	defEmpty.Scope.Steps[2].Reads = []string{}
	emptyRun := NewRun(defEmpty, []Row{inputRow("file-1", "сырьё")})
	if err := emptyRun.Advance(); err != nil {
		t.Fatal(err)
	}
	applyFixtureCompletion(t, emptyRun, "normalized", normalizedRows)
	emptyRows, err := emptyRun.RowsFor(ResultRef{ID: "review", Generation: 1}, joinOutputLimit)
	if err != nil || len(emptyRows) != 0 {
		t.Fatalf("явный пустой reads даёт пустой preview: %+v %v", emptyRows, err)
	}
	if len(emptyRun.Nodes["review"].Selected) != 2 {
		t.Fatalf("управляющий Selected сохраняет обе зависимости: %+v", emptyRun.Nodes["review"].Selected)
	}
	nilRaw, _ := json.Marshal(Step{ID: "x", Title: "X", Kind: "input"})
	if strings.Contains(string(nilRaw), `"reads"`) {
		t.Fatalf("nil reads отсутствует в Go-байтах: %s", nilRaw)
	}
	emptyRaw, _ := json.Marshal(Step{ID: "x", Title: "X", Kind: "input", Reads: []string{}})
	if !strings.Contains(string(emptyRaw), `"reads":[]`) {
		t.Fatalf("пустой reads хранится как []: %s", emptyRaw)
	}
}

func TestDynamicAnyDoesNotSelectSkippedScope(t *testing.T) {
	def := Definition{
		Title: "Пропуск", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"files"},
			Steps: []Step{
				{ID: "list", Title: "Список", Kind: "input"},
				{ID: "files", Title: "Документы", Kind: "forEach", Source: "list", Needs: []string{"list"}, Mode: "any",
					Scope: &Scope{Returns: []string{"work"}, Steps: []Step{
						{ID: "parts", Title: "Части", Kind: "sections", Reads: []string{"$item"}},
						{ID: "work", Title: "Работа", Kind: "agent", Needs: []string{"parts"}, Reads: []string{"$item"},
							When: &Condition{Source: "parts", Test: "nonempty"}, Prompt: "сделай"},
					}}},
			},
		},
	}
	run := NewRun(def, []Row{inputRow("file-1", ""), inputRow("file-2", "текст")})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, run, "files.1.work", "skipped")
	assertStatus(t, run, "files", "running")
	assertStatus(t, run, "files.2.work", "ready")
	applyFixtureCompletion(t, run, "files.2.work", []Row{{Key: "w", Title: "Работа", Text: "готово"}})
	assertStatus(t, run, "files", "done")
	if !reflect.DeepEqual(run.Nodes["files"].Selected, []ResultRef{{ID: "files.2.work", Generation: 1}}) {
		t.Fatalf("any ждёт реальный успех и не выбирает пропущенную область: %+v", run.Nodes["files"].Selected)
	}
}

func TestConditionalCallSkipsChildren(t *testing.T) {
	def := Definition{
		Title: "Условный call", InputKind: "documents",
		Scope: Scope{
			Returns: []string{"out"},
			Steps: []Step{
				{ID: "items", Title: "Список", Kind: "input"},
				{ID: "sub", Title: "Подмаршрут", Kind: "call", Needs: []string{"items"},
					When: &Condition{Source: "items", Test: "nonempty"},
					Scope: &Scope{Returns: []string{"work"}, Steps: []Step{
						{ID: "work", Title: "Работа", Kind: "agent", Reads: []string{"$inputs"}, Prompt: "сделай"},
					}}},
				{ID: "out", Title: "Сборка", Kind: "join", Mode: "all", Needs: []string{"sub"}},
			},
		},
	}
	run := NewRun(def, []Row{})
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, run, "sub", "skipped")
	for id := range run.Nodes {
		if strings.HasPrefix(id, "sub.") {
			t.Fatalf("ложное условие не создаёт child IDs, найден %s", id)
		}
	}
	assertStatus(t, run, "out", "done")
}
