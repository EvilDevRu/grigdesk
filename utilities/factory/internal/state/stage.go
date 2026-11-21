package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"

	"grigdesk.local/tools/utilities/factory/internal/route"
)

var ErrStageAbsent = errors.New("stage ledger ещё не инициализирован")
var ErrStagePending = errors.New("у stage ledger есть неопубликованный хвост указателя")

var stageIdentityFields = []string{
	"schema", "protocolVersion", "taskId", "attemptId", "profile", "catalogHash", "route", "routeHash",
}

type StageSnapshot struct {
	Sequence      int64
	HeadEventHash string
	CurrentNode   string
	State         string
	Stop          string
}

type StageEvent struct {
	Hash string
	Raw  []byte
	Data map[string]any
}

type stageLedger struct {
	attempt               Attempt
	bundle                route.MachineBundle
	entry                 string
	events                []StageEvent
	pointer               record
	loopRounds, loopStage int64
}

// ReadStage открывает курсор из доверенной цепочки событий одной попытки.
// Проверка не использует запись .pipeline и не достраивает указатель.
func (s Store) ReadStage(task, attempt string) (StageSnapshot, error) {
	if !attemptPattern.MatchString(attempt) {
		return StageSnapshot{}, fmt.Errorf("stage: нужна точная попытка")
	}
	t, err := s.openTask(task, false)
	if err != nil {
		return StageSnapshot{}, err
	}
	defer t.close()
	ledger, dir, err := t.loadStage(task, attempt, false)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return StageSnapshot{}, err
	}
	return ledger.snapshot(), nil
}

// loadStage закрепляет каталог, владельца и физический путь stage-results.
// При ошибке курсора возвращает уже проверенные части только внутреннему caller.
func (t *taskState) loadStage(task, id string, write bool) (stageLedger, *os.Root, error) {
	ledger := stageLedger{}
	attempt, err := t.readAttempt(task, id)
	if err != nil {
		return ledger, nil, err
	}
	if attempt.Terminal != "" && write {
		return ledger, nil, fmt.Errorf("%w: попытка закрыта", ErrConflict)
	}
	if attempt.Terminal == "" {
		active, err := t.activeAttempt(task)
		if err != nil || active != id {
			return ledger, nil, fmt.Errorf("%w: нет точной активной попытки", ErrConflict)
		}
	}
	if attempt.RouteID == "" {
		return ledger, nil, ErrStageAbsent
	}
	reader, err := route.NewBundleReader(attempt.RoutesDir, attempt.Profile)
	if err != nil {
		return ledger, nil, err
	}
	bundle, err := reader.ReadRoute(attempt.RouteID, attempt.RouteHash)
	if err != nil {
		return ledger, nil, err
	}
	path := filepath.Join("attempts", id, "stage-results")
	if err := ensurePrivateDirectory(t.root, path, false); err != nil {
		return ledger, nil, err
	}
	dir, err := t.root.OpenRoot(path)
	if err != nil {
		return ledger, nil, err
	}
	ledger = stageLedger{attempt: attempt, bundle: bundle, entry: stringField(bundle.Machine, "entry")}
	err = ledger.read(dir)
	return ledger, dir, err
}

// read повторяет каждую дугу от init до текущего head.
// Хэш события берётся из прочитанных байтов, отдельно от checksum указателя.
func (l *stageLedger) read(dir *os.Root) error {
	entries, err := fs.ReadDir(dir.FS(), ".")
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return ErrStageAbsent
	}
	var before record
	var previous any
	for _, entry := range entries {
		name := entry.Name()
		if name == "runtime.json" {
			continue
		}
		raw, err := readTrusted(dir, name, metadataBytes, immutableMode)
		if err != nil {
			return err
		}
		hash := digestOf(raw)
		sequence := len(l.events)
		if name != fmt.Sprintf("event.%020d.%s.json", sequence, hash) {
			return fmt.Errorf("stage: хэш события, sequence или имя не совпадает")
		}
		event, err := decodeRecord(raw)
		if err != nil {
			return err
		}
		if err := l.validateEvent(event, before, previous, int64(sequence)); err != nil {
			return err
		}
		l.events = append(l.events, StageEvent{Hash: hash, Raw: raw, Data: event})
		before, _ = event["after"].(record)
		previous = hash
	}
	if len(l.events) == 0 {
		return fmt.Errorf("stage: отсутствует init event")
	}
	pointer, err := readRuntimePointer(dir)
	if err != nil {
		return err
	}
	l.pointer = pointer
	last := l.events[len(l.events)-1]
	if reflect.DeepEqual(pointer, l.runtimeFrom(last)) {
		return nil
	}
	if len(l.events) > 1 && reflect.DeepEqual(pointer, l.runtimeFrom(l.events[len(l.events)-2])) {
		return ErrStagePending
	}
	return fmt.Errorf("stage: указатель не совпадает с проверенной цепочкой")
}

// readRuntimePointer проверяет envelope перед доступом к cursor.
// Checksum использует компактные ключи в порядке Unicode и конечный LF.
func readRuntimePointer(dir *os.Root) (record, error) {
	raw, err := readTrusted(dir, "runtime.json", metadataBytes, immutableMode)
	if err != nil {
		return nil, err
	}
	data, err := decodeRecord(raw)
	if err != nil || !exactFields(data, "checksum", "runtime") {
		return nil, fmt.Errorf("stage: неверный envelope указателя")
	}
	pointer, _ := data["runtime"].(record)
	if pointer == nil {
		return nil, fmt.Errorf("stage: указатель должен быть объектом")
	}
	canonical, err := compactRecord(pointer)
	if err != nil || data["checksum"] != digestOf(canonical) {
		return nil, fmt.Errorf("stage: checksum указателя не совпадает")
	}
	return pointer, nil
}

// validateEvent проверяет identity, предыдущий хэш и форму перехода.
// Сначала сверяется полный предыдущий cursor, затем вычисляется новый.
func (l *stageLedger) validateEvent(event, before record, previous any, sequence int64) error {
	kind, node := stringField(event, "kind"), stringField(event, "node")
	fields := append(slices.Clone(stageIdentityFields), "sequence", "at", "kind", "node", "outcome",
		"reason", "action", "previousEventHash", "before", "after")
	for _, optional := range []string{"verdict", "actor", "loop", "continues"} {
		if _, exists := event[optional]; exists {
			fields = append(fields, optional)
		}
	}
	if !exactFields(event, fields...) || !l.identityMatches(event) || !stagePattern.MatchString(node) ||
		!validTimestamp(stringField(event, "at")) ||
		event["sequence"] != json.Number(strconv.FormatInt(sequence, 10)) ||
		!reflect.DeepEqual(event["previousEventHash"], previous) {
		return fmt.Errorf("stage: повреждённая identity события %d", sequence)
	}
	if actor, exists := event["actor"]; exists {
		text, _ := actor.(string)
		if kind != "human-rewind" || text == "human" || !stagePattern.MatchString(text) {
			return fmt.Errorf("stage: неверный actor")
		}
	}
	if (event["loop"] != nil || event["continues"] != nil) && l.bundle.Machine["loop"] == nil {
		return fmt.Errorf("stage: запись цикла без закреплённого loop")
	}
	if err := validateStageVerdict(event["verdict"], stringField(event, "outcome")); err != nil {
		return err
	}
	after, ok := event["after"].(record)
	if !ok || !validStageCursor(after, sequence) {
		return fmt.Errorf("stage: повреждённый cursor события %d", sequence)
	}
	if sequence == 0 {
		if err := l.validateStageLoop(event); err != nil {
			return err
		}
		return l.validateInit(event, after)
	}
	if !reflect.DeepEqual(event["before"], before) ||
		(kind != "human-rewind" && kind != "loop-continue" && before["currentNode"] != node) {
		return fmt.Errorf("stage: предшествующий cursor не совпадает")
	}
	expected, err := l.deriveCursor(event, before, sequence)
	if err != nil || !reflect.DeepEqual(after, expected) {
		return fmt.Errorf("stage: переход %d не соответствует cursor", sequence)
	}
	return l.validateStageLoop(event)
}

// validateInit подтверждает, что история начинается именно с закреплённого entry.
// Начальное событие не содержит результата узла и не имеет родителя.
func (l stageLedger) validateInit(event, cursor record) error {
	if event["kind"] != "init" || event["node"] != l.entry || event["outcome"] != nil ||
		event["reason"] != nil || event["before"] != nil ||
		!reflect.DeepEqual(event["action"], record{"next": l.entry}) ||
		!reflect.DeepEqual(cursor, makeCursor("ready", l.entry, nil, nil, nil)) {
		return fmt.Errorf("stage: неверная начальная запись")
	}
	return nil
}

// validStageCursor сверяет различия между ready, paused и stopped.
// Last commit остаётся в пределах уже записанной цепочки.
func validStageCursor(cursor record, sequence int64) bool {
	if !exactFields(cursor, "state", "currentNode", "stop", "pauseReason", "lastCommit") {
		return false
	}
	if raw := cursor["lastCommit"]; raw != nil {
		last, _ := raw.(record)
		if !exactFields(last, "node", "outcome", "sequence") ||
			!stagePattern.MatchString(stringField(last, "node")) ||
			!stagePattern.MatchString(stringField(last, "outcome")) {
			return false
		}
		id, _ := last["sequence"].(json.Number)
		index, err := id.Int64()
		if err != nil || index < 1 || index > sequence {
			return false
		}
	}
	node := stringField(cursor, "currentNode")
	switch cursor["state"] {
	case "ready":
		return stagePattern.MatchString(node) && cursor["stop"] == nil && cursor["pauseReason"] == nil
	case "paused":
		return stagePattern.MatchString(node) && cursor["stop"] == nil &&
			validReason(stringField(cursor, "pauseReason"))
	case "stopped":
		targets := []string{"done", "human", "failed", "rewind-limit", "no-progress", "loop-ceiling"}
		return cursor["currentNode"] == nil && cursor["pauseReason"] == nil &&
			slices.Contains(targets, stringField(cursor, "stop"))
	default:
		return false
	}
}

func makeCursor(state string, node, stop, reason, last any) record {
	return record{
		"state": state, "currentNode": node, "stop": stop, "pauseReason": reason, "lastCommit": last,
	}
}

// deriveCursor вычисляет постусловие события по прежнему cursor.
// Отдельные виды журнала не могут произвольно менять уже подтверждённый узел.
func (l stageLedger) deriveCursor(event, before record, sequence int64) (record, error) {
	node, outcome := stringField(event, "node"), stringField(event, "outcome")
	kind, reason := stringField(event, "kind"), stringField(event, "reason")
	action, _ := event["action"].(record)
	running := before["state"] == "ready" || before["state"] == "paused"
	last := record{"node": node, "outcome": outcome, "sequence": json.Number(strconv.FormatInt(sequence, 10))}

	switch kind {
	case "pause":
		if before["state"] == "ready" && event["outcome"] == nil && event["action"] == nil &&
			validReason(reason) {
			return makeCursor("paused", node, nil, reason, before["lastCommit"]), nil
		}
	case "human-rewind":
		target, valid := rewindTarget(action)
		stops := []string{"human", "rewind-limit", "no-progress", "loop-ceiling"}
		if (running || slices.Contains(stops, stringField(before, "stop"))) &&
			valid && target == node && event["outcome"] == nil && validReason(reason) {
			return makeCursor("ready", node, nil, nil, before["lastCommit"]), nil
		}
	case "commit":
		if running && stagePattern.MatchString(outcome) && validCommitReason(event, outcome) {
			return commitCursor(action, last)
		}
	case "rewind-limit", "no-progress", "loop-ceiling":
		if _, valid := rewindTarget(action); running && valid && stagePattern.MatchString(outcome) &&
			validReason(reason) {
			return makeCursor("stopped", nil, kind, nil, last), nil
		}
	case "loop-continue":
		return l.continueLoopCursor(event, before, action, sequence)
	}
	return nil, fmt.Errorf("stage: исход %s несовместим с видом %s", outcome, kind)
}

func validCommitReason(event record, outcome string) bool {
	const recovery = "узел не исполнялся: при восстановлении снята инструментация"
	if event["reason"] == nil || event["reason"] == recovery {
		return true
	}
	return (outcome == "rejected" || outcome == "skipped") && validReason(stringField(event, "reason"))
}

// continueLoopCursor подтверждает ссылку на единственную предыдущую остановку.
// Курcор возвращается на исполнителя с сохранением предыдущего lastCommit.
func (l stageLedger) continueLoopCursor(event, before, action record, sequence int64) (record, error) {
	if len(l.events) == 0 || before["stop"] != "loop-ceiling" {
		return nil, fmt.Errorf("stage: продолжение без loop ceiling")
	}
	previous := l.events[len(l.events)-1]
	reference, _ := event["continues"].(record)
	target, valid := rewindTarget(action)
	if !valid || previous.Data["kind"] != "loop-ceiling" ||
		!exactFields(reference, "sequence", "eventHash") || reference["eventHash"] != previous.Hash ||
		reference["sequence"] != json.Number(strconv.FormatInt(sequence-1, 10)) ||
		!validReason(stringField(event, "reason")) {
		return nil, fmt.Errorf("stage: неверное продолжение цикла")
	}
	for _, name := range []string{"node", "outcome", "action", "verdict"} {
		if !reflect.DeepEqual(event[name], previous.Data[name]) {
			return nil, fmt.Errorf("stage: содержимое решения цикла изменилось")
		}
	}
	return makeCursor("ready", target, nil, nil, before["lastCommit"]), nil
}

// commitCursor выводит следующий cursor из одного проверяемого действия.
// Эскалация на этом уровне запрещена после закрепления маршрута.
func commitCursor(action, last record) (record, error) {
	if next := stringField(action, "next"); exactFields(action, "next") && stagePattern.MatchString(next) {
		return makeCursor("ready", next, nil, nil, last), nil
	}
	if target, valid := rewindTarget(action); valid {
		return makeCursor("ready", target, nil, nil, last), nil
	}
	targets := []string{"human", "done", "failed"}
	if stop := stringField(action, "stop"); exactFields(action, "stop") && slices.Contains(targets, stop) {
		return makeCursor("stopped", nil, stop, nil, last), nil
	}
	return nil, fmt.Errorf("stage: неизвестное действие коммита")
}

// rewindTarget сверяет точное множество полей и первый элемент reset.
// Пустой или повторяющийся список не допускается.
func rewindTarget(action record) (string, bool) {
	target := stringField(action, "rewind")
	reset, _ := action["reset"].([]any)
	if !exactFields(action, "rewind", "reset") || !stagePattern.MatchString(target) ||
		len(reset) == 0 || reset[0] != target {
		return "", false
	}
	seen := make(map[string]bool)
	for _, raw := range reset {
		id, _ := raw.(string)
		if !stagePattern.MatchString(id) || seen[id] {
			return "", false
		}
		seen[id] = true
	}
	return target, true
}

// identityMatches сверяет часть события с точной immutable попыткой.
// Route и catalog хэши проверяются одновременно.
func (l stageLedger) identityMatches(event record) bool {
	expected := l.identity()
	for _, key := range stageIdentityFields {
		if event[key] != expected[key] {
			return false
		}
	}
	return true
}

func (l stageLedger) identity() record {
	a := l.attempt
	return record{
		"schema": json.Number("1"), "protocolVersion": json.Number("2"), "taskId": a.Task,
		"attemptId": a.ID, "profile": a.Profile, "catalogHash": a.CatalogHash,
		"route": a.RouteID, "routeHash": a.RouteHash,
	}
}

// runtimeFrom материализует указатель из уже проверенного события.
// Полученный хэш относится к файлу, а не к повторной сериализации.
func (l stageLedger) runtimeFrom(event StageEvent) record {
	result := l.identity()
	maps.Copy(result, record{
		"entry": l.entry, "sequence": event.Data["sequence"], "headEventHash": event.Hash,
		"cursor": event.Data["after"],
	})
	return result
}

// snapshot выдаёт минимальную проекцию подтверждённого курсора.
// Consumer не получает возможности менять записи внутреннего журнала.
func (l stageLedger) snapshot() StageSnapshot {
	cursor, _ := l.pointer["cursor"].(record)
	sequence, _ := l.pointer["sequence"].(json.Number)
	value, _ := sequence.Int64()
	return StageSnapshot{
		Sequence: value, HeadEventHash: stringField(l.pointer, "headEventHash"),
		CurrentNode: stringField(cursor, "currentNode"), State: stringField(cursor, "state"),
		Stop: stringField(cursor, "stop"),
	}
}

// compactRecord сохраняет историческое представление stage checksum.
// Lifecycle использует отдельную сортировку ключей и отдельную границу числа.
func compactRecord(value record) ([]byte, error) {
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(value)
	return output.Bytes(), err
}
