package graphworkflow

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Row — запись набора: ключ уникален в наборе, sources адресуют сохранённый вход.
type Row struct {
	Key     string      `json:"key"`
	Title   string      `json:"title"`
	Text    string      `json:"text"`
	Sources []SourceRef `json:"sources,omitempty"`
}

// SourceRef ссылается на физическую строку TXT/MD или элемент JSON, начиная с 1.
type SourceRef struct {
	InputKey string `json:"inputKey"`
	Line     int    `json:"line"`
	TimeMs   *int64 `json:"timeMs,omitempty"`
}

// InputFile — единственный допустимый вид загруженного входа.
type InputFile struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

// ModelRef — разрешённая модель снимка; повтор входа узнаёт её после смены реестра.
type ModelRef struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Effort   string `json:"effort,omitempty"`
}

type ResultRef struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
}

type Dependency struct {
	ID         string
	Generation uint64
	Status     string
	AcceptedAt uint64
}

type Decision struct {
	Ready    bool
	Blocked  bool
	Selected []ResultRef
}

// ReadRef — замороженная ссылка данных: локальный $inputs/$item либо принятое поколение.
type ReadRef struct {
	Local string     `json:"local,omitempty"`
	Dep   *ResultRef `json:"dep,omitempty"`
}

// RowRef адресует строку экземпляра либо сохранённого входа ($inputs).
type RowRef struct {
	NodeID     string `json:"nodeId"`
	Generation uint64 `json:"generation"`
	RowIndex   int    `json:"rowIndex"`
}

// Instance — один экземпляр шага; повторяемые ветки сохраняют ID и растят generation.
type Instance struct {
	ID           string      `json:"id"`
	LocalID      string      `json:"localId"`
	Parent       string      `json:"parent"`
	Prefix       string      `json:"prefix"`
	Kind         string      `json:"kind"`
	Title        string      `json:"title"`
	Status       string      `json:"status"`
	Generation   uint64      `json:"generation"`
	Slot         int         `json:"slot"`
	Selected     []ResultRef `json:"selected,omitempty"`
	DataRefs     []ReadRef   `json:"dataRefs,omitempty"`
	AcceptedAt   uint64      `json:"acceptedAt,omitempty"`
	Members      []string    `json:"members,omitempty"`
	ActiveItems  []string    `json:"activeItems,omitempty"`
	Rounded      int         `json:"rounded,omitempty"`
	ArgumentRefs []ReadRef   `json:"argumentRefs,omitempty"`
	ItemRef      *RowRef     `json:"itemRef,omitempty"`
	Rows         []Row       `json:"rows,omitempty"`
	Claim        *Lease      `json:"claim,omitempty"`
	ErrorCode    string      `json:"errorCode,omitempty"`
	Feedback     string      `json:"feedback,omitempty"`
}

// Event — действие истории: решения, повторы и завершения без дублирования содержимого.
type Event struct {
	At         uint64      `json:"at"`
	Kind       string      `json:"kind"`
	NodeID     string      `json:"nodeId,omitempty"`
	Generation uint64      `json:"generation,omitempty"`
	Approve    *bool       `json:"approve,omitempty"`
	Target     string      `json:"target,omitempty"`
	Comment    string      `json:"comment,omitempty"`
	ErrorCode  string      `json:"errorCode,omitempty"`
	Selected   []ResultRef `json:"selected,omitempty"`
}

// Snapshot — один атомарный снимок прогона: состояние, входы и история попыток.
// Generations хранит максимальное поколение каждого ID отдельно от текущих nodes.
type Snapshot struct {
	ID               string               `json:"id"`
	Title            string               `json:"title"`
	Definition       Definition           `json:"definition"`
	TemplateID       string               `json:"templateId"`
	TemplateRevision string               `json:"templateRevision"`
	CreatedAt        int64                `json:"createdAt"`
	Clock            uint64               `json:"clock"`
	Paused           bool                 `json:"paused"`
	Rejected         bool                 `json:"rejected"`
	Inputs           []Row                `json:"inputs"`
	Manifest         []InputFile          `json:"manifest"`
	ModelRef         ModelRef             `json:"modelRef"`
	Nodes            map[string]*Instance `json:"nodes"`
	Order            []string             `json:"order"`
	Issued           int                  `json:"issued"`
	Events           []Event              `json:"events"`
	Generations      map[string]uint64    `json:"generations,omitempty"`
	SlotSeq          int                  `json:"slotSeq"`
}

var ErrOutputLimit = errors.New("output_limit")
var ErrInputLimit = errors.New("input_limit")
var ErrNodeLimit = errors.New("node_limit")

const (
	joinOutputLimit   = 128 * 1024
	ReviewOutputLimit = 512 * 1024
	claimRowsLimit    = 4 * 1024 * 1024
	maxInstances      = 256
	maxAdvancePasses  = 512
)

// chooseDependencies определяет достаточность принятых результатов.
// Порядок для порога берётся из сохранённых номеров принятия и порядка needs.
func chooseDependencies(mode string, minimum int, needs []Dependency) Decision {
	success := make([]Dependency, 0, len(needs))
	wait, failed := 0, 0
	for _, need := range needs {
		switch need.Status {
		case "done":
			success = append(success, need)
		case "skipped":
		case "failed", "blocked":
			failed++
		default:
			wait++
		}
	}
	if mode == "" || mode == "all" {
		if failed > 0 {
			return Decision{Blocked: true}
		}
		if wait > 0 {
			return Decision{}
		}
		return readyWith(success)
	}
	if mode == "any" {
		minimum = 1
	}
	if len(success) < minimum {
		return Decision{Blocked: len(success)+wait < minimum}
	}
	slices.SortStableFunc(success, func(left, right Dependency) int {
		return cmp.Compare(left.AcceptedAt, right.AcceptedAt)
	})
	return readyWith(success[:minimum])
}

// readyWith сохраняет точные поколения всех потреблённых результатов.
// Результаты экземпляра из другого поколения в эти входы попасть не могут.
func readyWith(deps []Dependency) Decision {
	selected := make([]ResultRef, 0, len(deps))
	for _, dep := range deps {
		selected = append(selected, ResultRef{ID: dep.ID, Generation: dep.Generation})
	}
	return Decision{Ready: true, Selected: selected}
}

// BindReads преобразует декларации входов в ссылки на принятые поколения.
// Явный пустой список оставляет шаг без данных при наличии контрольных зависимостей.
func BindReads(step Step, prefix string, selected []ResultRef) []ReadRef {
	requested := step.Reads
	if requested == nil {
		if step.Kind == "input" {
			requested = []string{"$inputs"}
		} else {
			result := make([]ReadRef, 0, len(selected))
			for _, item := range selected {
				result = append(result, ReadRef{Dep: &item})
			}
			return result
		}
	}
	result := make([]ReadRef, 0, len(requested))
	for _, id := range requested {
		switch id {
		case "$inputs", "$item":
			result = append(result, ReadRef{Local: id})
		default:
			for _, item := range selected {
				if item.ID == prefix+id {
					result = append(result, ReadRef{Dep: &item})
					break
				}
			}
		}
	}
	return result
}

func isGroupKind(kind string) bool {
	return kind == "forEach" || kind == "call" || kind == "repeat"
}

func isModelKind(kind string) bool {
	return kind == "agent" || kind == "meetingTasks"
}

// NewRun создаёт корневые экземпляры в порядке шагов; входы уже нормализованы вызывающим.
// Манифест и идентификатор назначает операция старта под блокировкой хранилища.
func NewRun(definition Definition, inputs []Row) *Snapshot {
	run := &Snapshot{
		Title:       definition.Title,
		Definition:  definition,
		Inputs:      inputs,
		Nodes:       map[string]*Instance{},
		Generations: map[string]uint64{},
	}
	for _, step := range definition.Scope.Steps {
		run.makeInstance("", "", step, nil, nil, "")
	}
	return run
}

// makeInstance выделяет экземпляр с монотонным поколением и номером размещения.
// Повторное разворачивание декларации после возврата никогда не повторяет поколение.
func (run *Snapshot) makeInstance(prefix, parent string, step Step, argumentRefs []ReadRef,
	itemRef *RowRef, feedback string,
) *Instance {
	id := prefix + step.ID
	generation := run.Generations[id] + 1
	run.Generations[id] = generation
	node := &Instance{
		ID:           id,
		LocalID:      step.ID,
		Parent:       parent,
		Prefix:       prefix,
		Kind:         step.Kind,
		Title:        step.Title,
		Status:       "pending",
		Generation:   generation,
		Slot:         run.SlotSeq,
		ArgumentRefs: argumentRefs,
		ItemRef:      itemRef,
	}
	run.SlotSeq++
	if (isModelKind(step.Kind) || isGroupKind(step.Kind)) && feedback != "" {
		node.Feedback = feedback
	}
	run.Nodes[id] = node
	run.Order = append(run.Order, id)
	run.Issued++
	return node
}

// newScope создаёт дочернюю область с замороженными аргументами и элементом.
// Порядок детей повторяет порядок шагов объявления, бюджет проверен до выделения.
func (run *Snapshot) newScope(prefix, parent string, scope Scope, argumentRefs []ReadRef,
	itemRef *RowRef, feedback string,
) []string {
	roots := make([]string, 0, len(scope.Steps))
	for _, step := range scope.Steps {
		node := run.makeInstance(prefix, parent, step, argumentRefs, itemRef, feedback)
		roots = append(roots, node.ID)
	}
	return roots
}

// declOf находит объявление шага по пути родителя и локальному ID.
// Глубина областей ограничена валидатором, поэтому обход короткий.
func (run *Snapshot) declOf(node *Instance) Step {
	scope := run.Definition.Scope
	if node.Parent != "" {
		parent := run.Nodes[node.Parent]
		if parent != nil {
			scope = *run.declOf(parent).Scope
		}
	}
	for _, step := range scope.Steps {
		if step.ID == node.LocalID {
			return step
		}
	}
	return Step{}
}

// DeclOf открывает объявление экземпляра для проекции API без повторного обхода.
func (run *Snapshot) DeclOf(node *Instance) Step {
	return run.declOf(node)
}

// GroupOutputs отдаёт реальные возвращаемые вершины группы для схемы прогона.
// До принятия порога видны все материализованные выходы, после — выбранные.
func (run *Snapshot) GroupOutputs(node *Instance) []string {
	if !isGroupKind(node.Kind) {
		return nil
	}
	if node.Status == "done" {
		outputs := make([]string, 0, len(node.Selected))
		for _, ref := range node.Selected {
			outputs = append(outputs, ref.ID)
		}
		return outputs
	}
	decl := run.declOf(node)
	outputs := make([]string, 0)
	for ordinal := 1; ordinal <= node.Rounded; ordinal++ {
		prefix := node.ID + "." + strconv.Itoa(ordinal) + "."
		for _, ret := range decl.Scope.Returns {
			id := prefix + ret
			if run.Nodes[id] != nil {
				outputs = append(outputs, id)
			}
		}
	}
	return outputs
}

// GroupCounts считает терминальные и активные листья группы для компактной сводки.
func (run *Snapshot) GroupCounts(node *Instance) (total, done, running, failed int) {
	prefix := node.ID + "."
	for _, id := range run.Order {
		member := run.Nodes[id]
		if member == nil || !strings.HasPrefix(member.ID, prefix) || isGroupKind(member.Kind) {
			continue
		}
		total++
		switch member.Status {
		case "done", "skipped":
			done++
		case "failed", "blocked":
			failed++
		case "ready", "running", "waiting":
			running++
		}
	}
	return total, done, running, failed
}

// Advance проходит порядок выделения до неподвижной точки.
// Пауза запрещает новые готовности и выдачи, но закрывает принятые завершения.
func (run *Snapshot) Advance() error {
	if run.Rejected {
		return nil
	}
	for pass := 0; pass < maxAdvancePasses; pass++ {
		changed := false
		order := append([]string(nil), run.Order...)
		for _, id := range order {
			node := run.Nodes[id]
			if node == nil {
				continue
			}
			did, err := run.advanceNode(node)
			if err != nil {
				return err
			}
			changed = changed || did
		}
		if !changed {
			return nil
		}
	}
	return fmt.Errorf("advance: превышен предел переходов, внутренний инвариант нарушен")
}

func (run *Snapshot) advanceNode(node *Instance) (bool, error) {
	if node.Kind == "forEach" && node.Rounded > 0 && !run.Paused {
		if limit := run.declOf(node).Parallelism; limit > 0 {
			run.admitItems(node, limit)
		}
	}
	switch node.Status {
	case "pending":
		return run.startNode(node)
	case "running":
		if isGroupKind(node.Kind) {
			return run.aggregateGroup(node)
		}
	}
	return false, nil
}

// startNode применяет управляющий порог, условие и переход из pending.
// Selected и DataRefs фиксируются один раз при переходе, до выдачи модели.
func (run *Snapshot) startNode(node *Instance) (bool, error) {
	for member := node; member.Parent != ""; {
		parent := run.Nodes[member.Parent]
		if parent == nil {
			return false, fmt.Errorf("advance: отсутствует родитель %s", member.Parent)
		}
		if parent.Kind == "forEach" && run.declOf(parent).Parallelism > 0 &&
			!slices.Contains(parent.ActiveItems, member.Prefix) {
			return false, nil
		}
		member = parent
	}
	decl := run.declOf(node)
	if decl.When != nil {
		source := run.Nodes[node.Prefix+decl.When.Source]
		if source == nil {
			return false, fmt.Errorf("advance: неизвестный источник условия %s", node.ID)
		}
		switch source.Status {
		case "failed", "blocked":
			node.Status = "blocked"
			return true, nil
		case "done", "skipped":
			empty := true
			if source.Status == "done" {
				refs, err := run.RowsRefsFor(ResultRef{ID: source.ID, Generation: source.Generation})
				if err != nil {
					return false, err
				}
				empty = len(refs) == 0
			}
			matches := empty == (decl.When.Test == "empty")
			if !matches {
				node.Status = "skipped"
				return true, nil
			}
		default:
			return false, nil
		}
	}
	needs := make([]Dependency, 0, len(decl.Needs))
	for _, id := range decl.Needs {
		dep := run.Nodes[node.Prefix+id]
		if dep == nil {
			return false, fmt.Errorf("advance: неизвестная зависимость %s%s", node.Prefix, id)
		}
		needs = append(needs, Dependency{
			ID: dep.ID, Generation: dep.Generation, Status: dep.Status, AcceptedAt: dep.AcceptedAt,
		})
	}
	decision := chooseDependencies("", 0, needs)
	if node.Kind == "join" {
		decision = chooseDependencies(decl.Mode, decl.MinSuccess, needs)
	}
	if decision.Blocked {
		node.Status = "blocked"
		return true, nil
	}
	if !decision.Ready {
		return false, nil
	}
	if run.Paused && (isModelKind(node.Kind) || isGroupKind(node.Kind)) {
		return false, nil
	}
	node.Selected = decision.Selected
	node.DataRefs = BindReads(decl, node.Prefix, decision.Selected)
	switch node.Kind {
	case "input":
		return run.acceptLeaf(node), nil
	case "sections":
		rows, err := run.sectionsRows(node)
		if err != nil {
			node.Status = "failed"
			node.ErrorCode = err.Error()
			return true, nil
		}
		node.Rows = rows
		return run.acceptLeaf(node), nil
	case "join":
		if _, err := run.RowsFor(ResultRef{ID: node.ID, Generation: node.Generation}, joinOutputLimit); err != nil {
			node.Status = "failed"
			node.ErrorCode = err.Error()
			return true, nil
		}
		return run.acceptLeaf(node), nil
	case "approval":
		if _, err := run.RowsFor(ResultRef{ID: node.ID, Generation: node.Generation}, ReviewOutputLimit); err != nil {
			node.Status = "failed"
			node.ErrorCode = err.Error()
			return true, nil
		}
		node.Status = "waiting"
		return true, nil
	case "agent", "meetingTasks":
		node.Status = "ready"
		return true, nil
	default:
		return run.materializeGroup(node, decl)
	}
}

func (run *Snapshot) acceptLeaf(node *Instance) bool {
	run.Clock++
	node.AcceptedAt = run.Clock
	node.Status = "done"
	return true
}

// materializeGroup проверяет бюджет до первого дочернего ID и открывает области.
// Пустая группа all завершается сразу, пороговая — явным недостижимым порогом.
func (run *Snapshot) materializeGroup(node *Instance, decl Step) (bool, error) {
	scope := *decl.Scope
	if node.Kind == "forEach" {
		var sourceRef ResultRef
		for _, ref := range node.Selected {
			if ref.ID == node.Prefix+decl.Source {
				sourceRef = ref
				break
			}
		}
		rowRefs, err := run.RowsRefsFor(sourceRef)
		if err != nil {
			return false, err
		}
		if run.Issued+len(rowRefs)*len(scope.Steps) > maxInstances {
			node.Status = "failed"
			node.ErrorCode = ErrNodeLimit.Error()
			return true, nil
		}
		if len(rowRefs) == 0 {
			if decl.Mode == "" || decl.Mode == "all" {
				node.Selected = []ResultRef{}
				return run.acceptLeaf(node), nil
			}
			node.Status = "blocked"
			node.ErrorCode = "threshold_unreachable"
			return true, nil
		}
		for index, rowRef := range rowRefs {
			prefix := node.ID + "." + strconv.Itoa(index+1) + "."
			item := rowRef
			roots := run.newScope(prefix, node.ID, scope, node.DataRefs, &item, node.Feedback)
			node.Members = append(node.Members, roots...)
		}
		node.Rounded = len(rowRefs)
		node.Status = "running"
		return true, nil
	}
	if run.Issued+len(scope.Steps) > maxInstances {
		node.Status = "failed"
		node.ErrorCode = ErrNodeLimit.Error()
		return true, nil
	}
	prefix := node.ID + ".1."
	roots := run.newScope(prefix, node.ID, scope, node.DataRefs, node.ItemRef, node.Feedback)
	node.Members = append(node.Members, roots...)
	node.Rounded = 1
	node.Status = "running"
	return true, nil
}

// admitItems сохраняет допуск на весь срок работы области элемента, включая ворота.
// Освободившиеся места получают незавершённые области в порядке исходных строк.
func (run *Snapshot) admitItems(node *Instance, limit int) {
	active := node.ActiveItems[:0]
	for _, prefix := range node.ActiveItems {
		if status, _ := run.itemStatus(node, prefix); status == "running" {
			active = append(active, prefix)
		}
	}
	for ordinal := 1; ordinal <= node.Rounded && len(active) < limit; ordinal++ {
		prefix := node.ID + "." + strconv.Itoa(ordinal) + "."
		if slices.Contains(active, prefix) {
			continue
		}
		if status, _ := run.itemStatus(node, prefix); status == "running" {
			active = append(active, prefix)
		}
	}
	node.ActiveItems = active
}

// itemStatus выводит синтетический статус области по её возвращаемым выходам.
// Порогово исключённые ошибки не-возвратных веток не отменяют успех области.
func (run *Snapshot) itemStatus(node *Instance, prefix string) (string, uint64) {
	for _, id := range run.Order {
		member := run.Nodes[id]
		if member != nil && strings.HasPrefix(member.ID, prefix) {
			switch member.Status {
			case "pending", "ready", "running", "waiting":
				return "running", 0
			}
		}
	}
	decl := run.declOf(node)
	done, skipped, failed, accepted := 0, 0, 0, uint64(0)
	for _, ret := range decl.Scope.Returns {
		member := run.Nodes[prefix+ret]
		if member == nil {
			return "running", 0
		}
		switch member.Status {
		case "done":
			done++
			accepted = max(accepted, member.AcceptedAt)
		case "skipped":
			skipped++
		case "failed", "blocked":
			failed++
		default:
			return "running", 0
		}
	}
	if done == 0 && failed == 0 {
		return "skipped", 0
	}
	if failed > 0 {
		return "failed", 0
	}
	if decl.Mode == "" || decl.Mode == "all" {
		for _, id := range run.Order {
			member := run.Nodes[id]
			if member != nil && strings.HasPrefix(member.ID, prefix) &&
				(member.Status == "failed" || member.Status == "blocked") {
				return "failed", 0
			}
		}
	}
	return "done", accepted
}

func (run *Snapshot) roundReturnRefs(node *Instance, ordinal int) []ResultRef {
	prefix := node.ID + "." + strconv.Itoa(ordinal) + "."
	decl := run.declOf(node)
	refs := make([]ResultRef, 0, len(decl.Scope.Returns))
	for _, ret := range decl.Scope.Returns {
		member := run.Nodes[prefix+ret]
		if member != nil && member.Status == "done" {
			refs = append(refs, ResultRef{ID: member.ID, Generation: member.Generation})
		}
	}
	return refs
}

func (run *Snapshot) roundOutputEmpty(node *Instance, ordinal int) bool {
	for _, ref := range run.roundReturnRefs(node, ordinal) {
		refs, err := run.RowsRefsFor(ref)
		if err == nil && len(refs) > 0 {
			return false
		}
	}
	return true
}

// aggregateGroup применяет правило сборки к синтетическим записям областей.
// Ранняя пороговая сборка открывает зависимые шаги, живые дети остаются видимыми.
func (run *Snapshot) aggregateGroup(node *Instance) (bool, error) {
	decl := run.declOf(node)
	if node.Kind == "repeat" {
		ordinal := node.Rounded
		status, _ := run.itemStatus(node, node.ID+"."+strconv.Itoa(ordinal)+".")
		switch status {
		case "running":
			return false, nil
		case "failed":
			node.Status = "blocked"
			node.ErrorCode = "dependency_failed"
			return true, nil
		default:
			if !run.roundOutputEmpty(node, ordinal) {
				node.Selected = run.roundReturnRefs(node, ordinal)
				return run.acceptLeaf(node), nil
			}
			if node.Rounded < decl.MaxRounds {
				if run.Issued+len(decl.Scope.Steps) > maxInstances {
					node.Status = "failed"
					node.ErrorCode = ErrNodeLimit.Error()
					return true, nil
				}
				next := node.Rounded + 1
				prefix := node.ID + "." + strconv.Itoa(next) + "."
				roots := run.newScope(prefix, node.ID, *decl.Scope, node.DataRefs, node.ItemRef, node.Feedback)
				node.Members = append(node.Members, roots...)
				node.Rounded = next
				return true, nil
			}
			node.Status = "failed"
			node.ErrorCode = "repeat_exhausted"
			return true, nil
		}
	}
	deps := make([]Dependency, 0, node.Rounded)
	for ordinal := 1; ordinal <= node.Rounded; ordinal++ {
		status, accepted := run.itemStatus(node, node.ID+"."+strconv.Itoa(ordinal)+".")
		deps = append(deps, Dependency{
			ID: strconv.Itoa(ordinal), Generation: 1, Status: status, AcceptedAt: accepted,
		})
	}
	decision := chooseDependencies(decl.Mode, decl.MinSuccess, deps)
	if decision.Blocked {
		node.Status = "blocked"
		if decl.Mode == "any" || decl.Mode == "quorum" {
			node.ErrorCode = "threshold_unreachable"
		} else {
			node.ErrorCode = "dependency_failed"
		}
		return true, nil
	}
	if !decision.Ready {
		return false, nil
	}
	selected := make([]ResultRef, 0, len(decision.Selected))
	for _, pick := range decision.Selected {
		ordinal, _ := strconv.Atoi(pick.ID)
		selected = append(selected, run.roundReturnRefs(node, ordinal)...)
	}
	node.Selected = selected
	return run.acceptLeaf(node), nil
}

var sectionHeader = regexp.MustCompile(`^#{1,6} `)

// sectionsRows делит прочитанные записи по заголовкам Markdown.
// Ключи частей наследуют исходный ключ и номер первой физической строки.
func (run *Snapshot) sectionsRows(node *Instance) ([]Row, error) {
	inputs, err := run.RowsFor(ResultRef{ID: node.ID, Generation: node.Generation}, claimRowsLimit)
	if err != nil {
		return nil, err
	}
	result := make([]Row, 0)
	for _, row := range inputs {
		if len(row.Sources) > 0 && row.Sources[0].TimeMs != nil {
			if strings.TrimSpace(row.Text) != "" {
				result = append(result, Row{Key: row.Key, Title: row.Title, Text: row.Text, Sources: row.Sources})
			}
			continue
		}
		parts, err := splitMarkdownSections(row)
		if err != nil {
			return nil, err
		}
		result = append(result, parts...)
	}
	return result, nil
}

// splitMarkdownSections режет текст файла по строкам заголовков.
// Без заголовков весь файл — один раздел, пустой файл даёт пустой набор.
func splitMarkdownSections(row Row) ([]Row, error) {
	lines := strings.Split(row.Text, "\n")
	type part struct {
		start int
		title string
		lines []string
	}
	var parts []part
	current := part{start: 1}
	flush := func() {
		text := strings.Join(current.lines, "\n")
		if strings.TrimSpace(text) != "" {
			parts = append(parts, current)
		}
	}
	for index, line := range lines {
		if sectionHeader.MatchString(line) {
			flush()
			current = part{start: index + 1, title: strings.TrimSpace(strings.TrimLeft(line, "# "))}
		}
		current.lines = append(current.lines, line)
	}
	flush()
	if len(parts) > 16 {
		return nil, ErrInputLimit
	}
	result := make([]Row, 0, len(parts))
	for _, p := range parts {
		title := p.title
		if title == "" {
			title = row.Title
		}
		sources := row.Sources
		if len(sources) > 0 {
			sources = []SourceRef{{InputKey: sources[0].InputKey, Line: p.start}}
		}
		result = append(result, Row{
			Key:     row.Key + "-l" + strconv.Itoa(p.start),
			Title:   title,
			Text:    strings.Join(p.lines, "\n"),
			Sources: sources,
		})
	}
	return result, nil
}

// RowsRefsFor отдаёт только ссылки строк принятого выхода без загрузки текста.
// Планировщик, preview ворот и сводка используют один этот метод.
func (run *Snapshot) RowsRefsFor(ref ResultRef) ([]RowRef, error) {
	node := run.Nodes[ref.ID]
	if node == nil || node.Generation != ref.Generation {
		return nil, fmt.Errorf("rows: устаревшая ссылка %s", ref.ID)
	}
	switch {
	case isModelKind(node.Kind) || node.Kind == "sections":
		if node.Status == "done" {
			refs := make([]RowRef, 0, len(node.Rows))
			for index := range node.Rows {
				refs = append(refs, RowRef{NodeID: node.ID, Generation: node.Generation, RowIndex: index})
			}
			return refs, nil
		}
		refs := make([]RowRef, 0)
		for _, read := range node.DataRefs {
			part, err := run.expandReadRef(node, read)
			if err != nil {
				return nil, err
			}
			refs = append(refs, part...)
		}
		return refs, nil
	case isGroupKind(node.Kind):
		refs := make([]RowRef, 0)
		for _, selected := range node.Selected {
			part, err := run.RowsRefsFor(selected)
			if err != nil {
				return nil, err
			}
			refs = append(refs, part...)
		}
		return refs, nil
	default:
		refs := make([]RowRef, 0)
		for _, read := range node.DataRefs {
			part, err := run.expandReadRef(node, read)
			if err != nil {
				return nil, err
			}
			refs = append(refs, part...)
		}
		return refs, nil
	}
}

// expandReadRef разворачивает одну ссылку данных в контексте её владельца.
// $inputs дочерней области заморожен аргументами группы и не меняется по кругам.
func (run *Snapshot) expandReadRef(owner *Instance, read ReadRef) ([]RowRef, error) {
	if read.Dep != nil {
		return run.RowsRefsFor(*read.Dep)
	}
	switch read.Local {
	case "$item":
		if owner.ItemRef == nil {
			return []RowRef{}, nil
		}
		return []RowRef{*owner.ItemRef}, nil
	case "$inputs":
		if owner.Parent == "" {
			refs := make([]RowRef, 0, len(run.Inputs))
			for index := range run.Inputs {
				refs = append(refs, RowRef{NodeID: "$inputs", RowIndex: index})
			}
			return refs, nil
		}
		group := run.Nodes[owner.Parent]
		if group == nil {
			return nil, fmt.Errorf("rows: потеряна группа области %s", owner.ID)
		}
		refs := make([]RowRef, 0)
		for _, arg := range owner.ArgumentRefs {
			part, err := run.expandReadRef(group, arg)
			if err != nil {
				return nil, err
			}
			refs = append(refs, part...)
		}
		return refs, nil
	default:
		return nil, fmt.Errorf("rows: неизвестная ссылка %s", read.Local)
	}
}

func (run *Snapshot) loadRow(ref RowRef) (Row, error) {
	if ref.NodeID == "$inputs" {
		if ref.RowIndex < 0 || ref.RowIndex >= len(run.Inputs) {
			return Row{}, fmt.Errorf("rows: вход вне диапазона")
		}
		return run.Inputs[ref.RowIndex], nil
	}
	node := run.Nodes[ref.NodeID]
	if node == nil || node.Generation != ref.Generation || ref.RowIndex < 0 || ref.RowIndex >= len(node.Rows) {
		return Row{}, fmt.Errorf("rows: устаревшая строка %s", ref.NodeID)
	}
	return node.Rows[ref.RowIndex], nil
}

func rowRefKey(ref RowRef) string {
	return ref.NodeID + "/" + strconv.FormatUint(ref.Generation, 10) + "/" + strconv.Itoa(ref.RowIndex)
}

func rowsEqual(left, right Row) bool {
	leftRaw, _ := json.Marshal(left)
	rightRaw, _ := json.Marshal(right)
	return string(leftRaw) == string(rightRaw)
}

// rowAccumulator собирает уникальные строки, разрешает коллизии ключей и держит лимит.
// Переполнение возвращает output_limit без частичной выдачи.
type rowAccumulator struct {
	rows    []Row
	byKey   map[string]int
	leafOf  map[int]string
	seenRef map[string]bool
	total   int
	limit   int
}

func (acc *rowAccumulator) add(ref RowRef, row Row) error {
	key := rowRefKey(ref)
	if acc.seenRef[key] {
		return nil
	}
	acc.seenRef[key] = true
	if previous, exists := acc.byKey[row.Key]; exists {
		if rowsEqual(acc.rows[previous], row) {
			return nil
		}
		oldKey := row.Key
		acc.rows[previous].Key = acc.leafOf[previous] + ":" + oldKey
		acc.byKey[acc.rows[previous].Key] = previous
		delete(acc.byKey, oldKey)
		row.Key = ref.NodeID + ":" + oldKey
	}
	raw, err := json.Marshal(row)
	if err != nil {
		return err
	}
	if acc.limit > 0 && acc.total+len(raw) > acc.limit {
		return ErrOutputLimit
	}
	acc.total += len(raw)
	acc.byKey[row.Key] = len(acc.rows)
	acc.leafOf[len(acc.rows)] = ref.NodeID
	acc.rows = append(acc.rows, row)
	return nil
}

// RowsFor разворачивает текст выхода с дедупликацией и лимитом фактических JSON-байтов.
// Сборка проверяет предел до done, claim — до выдачи модели.
func (run *Snapshot) RowsFor(ref ResultRef, limit int) ([]Row, error) {
	refs, err := run.RowsRefsFor(ref)
	if err != nil {
		return nil, err
	}
	acc := rowAccumulator{
		rows:    make([]Row, 0),
		byKey:   map[string]int{},
		leafOf:  map[int]string{},
		seenRef: map[string]bool{},
		limit:   limit,
	}
	for _, rowRef := range refs {
		row, err := run.loadRow(rowRef)
		if err != nil {
			return nil, err
		}
		if err := acc.add(rowRef, row); err != nil {
			return nil, err
		}
	}
	return acc.rows, nil
}

// liveWork считает активные модельные листья; группы с закрытыми детьми не держат прогон.
func (run *Snapshot) liveWork() int {
	count := 0
	for _, id := range run.Order {
		node := run.Nodes[id]
		if node != nil && isModelKind(node.Kind) && (node.Status == "ready" || node.Status == "running") {
			count++
		}
	}
	return count
}

func (run *Snapshot) waitingApproval() bool {
	for _, id := range run.Order {
		node := run.Nodes[id]
		if node != nil && node.Kind == "approval" && node.Status == "waiting" {
			return true
		}
	}
	return false
}

// Status вычисляет фактическую готовность прогона по обязательным выходам и активной работе.
func (run *Snapshot) Status() string {
	if run.Rejected {
		for _, node := range run.Nodes {
			if node.Claim != nil {
				return "running"
			}
		}
		return "rejected"
	}
	live := run.liveWork()
	if run.Paused {
		return "paused"
	}
	if live > 0 {
		return "running"
	}
	if run.waitingApproval() {
		return "waiting"
	}
	for _, ret := range run.Definition.Scope.Returns {
		node := run.Nodes[ret]
		if node == nil || (node.Status != "done" && node.Status != "skipped") {
			return "failed"
		}
	}
	return "done"
}

// MissingNode — незавершённая или отказавшая вершина управляющего дерева.
type MissingNode struct {
	NodeID    string `json:"nodeId"`
	ErrorCode string `json:"errorCode,omitempty"`
}

// ApprovalView — решение конкретных ворот в общей сводке.
type ApprovalView struct {
	State      string `json:"state"`
	NodeID     string `json:"nodeId"`
	Generation uint64 `json:"generation"`
	Comment    string `json:"comment,omitempty"`
}

// Preview — ссылочная сводка успешных листьев и состояние ворот.
type Preview struct {
	Incomplete bool
	Rows       []Row
	Missing    []MissingNode
	Approvals  []ApprovalView
}

// PreviewResult проходит текущий DAG в сохранённом порядке и собирает готовые строки.
// У ожидающих ворот обход заканчивается их точным preview без второго прохода.
func (run *Snapshot) PreviewResult() Preview {
	preview := Preview{Rows: []Row{}, Missing: []MissingNode{}, Approvals: []ApprovalView{}}
	visited := map[string]bool{}
	seenRef := map[string]bool{}
	refs := make([]RowRef, 0)
	var collect func(node *Instance)
	collect = func(node *Instance) {
		if node == nil || visited[node.ID] {
			return
		}
		visited[node.ID] = true
		switch node.Status {
		case "done", "waiting":
			part, err := run.RowsRefsFor(ResultRef{ID: node.ID, Generation: node.Generation})
			if err != nil {
				preview.Incomplete = true
				return
			}
			for _, ref := range part {
				key := rowRefKey(ref)
				if !seenRef[key] {
					seenRef[key] = true
					refs = append(refs, ref)
				}
			}
		case "skipped":
		default:
			if isGroupKind(node.Kind) {
				for _, member := range node.Members {
					collect(run.Nodes[member])
				}
				return
			}
			decl := run.declOf(node)
			reads := decl.Reads
			if reads == nil {
				if decl.Kind == "input" {
					reads = []string{"$inputs"}
				} else {
					reads = decl.Needs
				}
			}
			for _, id := range reads {
				if id == "$inputs" || id == "$item" {
					continue
				}
				collect(run.Nodes[node.Prefix+id])
			}
		}
	}
	for _, ret := range run.Definition.Scope.Returns {
		collect(run.Nodes[ret])
	}
	acc := rowAccumulator{
		rows:    make([]Row, 0),
		byKey:   map[string]int{},
		leafOf:  map[int]string{},
		seenRef: map[string]bool{},
	}
	for _, ref := range refs {
		row, err := run.loadRow(ref)
		if err != nil {
			preview.Incomplete = true
			continue
		}
		if err := acc.add(ref, row); err != nil {
			preview.Incomplete = true
		}
	}
	preview.Rows = acc.rows
	for _, id := range run.Order {
		node := run.Nodes[id]
		if node == nil {
			continue
		}
		switch node.Status {
		case "failed", "blocked", "waiting", "pending", "ready", "running":
			preview.Missing = append(preview.Missing, MissingNode{NodeID: node.ID, ErrorCode: node.ErrorCode})
		}
		if node.Kind == "approval" {
			switch node.Status {
			case "waiting":
				preview.Approvals = append(preview.Approvals, ApprovalView{
					State: "pending", NodeID: node.ID, Generation: node.Generation,
				})
			case "done":
				preview.Approvals = append(preview.Approvals, ApprovalView{
					State: "approved", NodeID: node.ID, Generation: node.Generation,
				})
			case "failed":
				if node.ErrorCode == "rejected" {
					view := ApprovalView{State: "rejected", NodeID: node.ID, Generation: node.Generation}
					for _, event := range run.Events {
						if event.Kind == "decision" && event.NodeID == node.ID && event.Approve != nil && !*event.Approve {
							view.Comment = event.Comment
						}
					}
					preview.Approvals = append(preview.Approvals, view)
				}
			}
		}
	}
	return preview
}
