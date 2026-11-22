package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

const lifecycleSegmentLimit = 256 * 1024 * 1024

var (
	activeSegmentPattern = regexp.MustCompile(`^active-([0-9]{16})\.ndjson$`)
	sealedSegmentPattern = regexp.MustCompile(`^sealed-([0-9]{16})\.ndjson$`)

	ErrLifecycleIncomplete = errors.New("lifecycle-incomplete: оборванный активный хвост")
	ErrLifecycleEventID    = errors.New("lifecycle-event-id-conflict")
)

type LifecycleEvent struct {
	Hash string
	Line []byte
	Data map[string]any
}

type lifecycleState struct {
	identity    Attempt
	manifest    record
	manifestRaw []byte
	events      []LifecycleEvent
	activeRaw   []byte
	validActive []byte
	torn        []byte
	activeFrom  int
}

// ReadLifecycle возвращает оригинальные проверенные строки lifecycle.
// Оборванный хвост остаётся на диске и требует отдельной операции writer.
func (s Store) ReadLifecycle(task, id string) ([]LifecycleEvent, error) {
	lifecycle, err := s.openLifecycle(task, id, false, false)
	if err != nil {
		return nil, err
	}
	defer lifecycle.close()
	ledger, err := loadLifecycle(lifecycle.root, lifecycle.identity)
	if err != nil {
		return nil, err
	}
	if len(ledger.torn) != 0 {
		return nil, ErrLifecycleIncomplete
	}
	return ledger.events, nil
}

type lifecycleDirectory struct {
	root     *os.Root
	lock     *os.File
	identity Attempt
}

func (d *lifecycleDirectory) close() {
	d.lock.Close()
	d.root.Close()
}

// openLifecycle проверяет владельца и открывает отдельный lock каталога lifecycle.
// Этот inode разделяется со старым append, а task lock нужен только для привязки к попытке.
func (s Store) openLifecycle(task, id string, write, create bool) (*lifecycleDirectory, error) {
	if !attemptPattern.MatchString(id) {
		return nil, fmt.Errorf("lifecycle: нужна exact attempt")
	}
	t, err := s.openTask(task, false)
	if err != nil {
		return nil, err
	}
	defer t.close()
	attempt, err := t.readAttempt(task, id)
	if err != nil {
		return nil, err
	}
	return t.openLifecycleFor(attempt, write, create)
}

func (t *taskState) openLifecycleFor(attempt Attempt, write, create bool) (*lifecycleDirectory, error) {
	name := filepath.Join("attempts", attempt.ID, "lifecycle")
	if err := ensurePrivateDirectory(t.root, name, create); err != nil {
		return nil, err
	}
	if create {
		if err := host.SyncDirectory(t.root, filepath.Dir(name)); err != nil {
			return nil, err
		}
	}
	root, err := t.root.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	lock, err := openDirectoryLock(root, ".", write)
	if err != nil {
		root.Close()
		return nil, err
	}
	operation := lockShared
	if write {
		operation = lockExclusive
	}
	if err := flock(lock, operation); err != nil {
		lock.Close()
		root.Close()
		return nil, err
	}
	return &lifecycleDirectory{root: root, lock: lock, identity: attempt}, nil
}

// loadLifecycle считывает manifest и серию выбранных им сегментов.
// Сегмент вне manifest не может стать частью цепочки даже при совпадающем имени.
func loadLifecycle(root *os.Root, attempt Attempt) (lifecycleState, error) {
	ledger := lifecycleState{identity: attempt}
	for _, dir := range []string{"segments", "quarantine", "usage"} {
		if err := ensurePrivateDirectory(root, dir, false); err != nil {
			return ledger, err
		}
	}
	raw, err := readTrusted(root, "manifest.json", metadataBytes, ownerMode)
	if err != nil {
		return ledger, err
	}
	manifest, err := parseLifecycleRecord(raw, metadataBytes)
	if err != nil {
		return ledger, err
	}
	canonical, err := lifecycleBytes(manifest, metadataBytes)
	if err != nil || !bytes.Equal(raw, append(canonical, '\n')) {
		return ledger, fmt.Errorf("lifecycle: manifest не является канонической строкой")
	}
	if err := verifyManifest(manifest); err != nil {
		return ledger, err
	}
	ledger.manifest, ledger.manifestRaw = manifest, raw
	seen := make(map[string]bool)
	for _, item := range arrayField(manifest, "sealedSegments") {
		descriptor, _ := item.(record)
		if err := ledger.loadSegment(root, stringField(descriptor, "name"), descriptor, seen); err != nil {
			return ledger, err
		}
	}
	ledger.activeFrom = len(ledger.events)
	if err := ledger.loadSegment(root, stringField(manifest, "activeSegment"), nil, seen); err != nil {
		return ledger, err
	}
	if err := verifyLifecycleScopes(ledger.events, attempt); err != nil {
		return ledger, err
	}
	return ledger, nil
}

// verifyManifest проверяет порядок переходов между поколениями.
// Неизменяемые sealed сегменты образуют отдельную цепочку content SHA.
func verifyManifest(value record) error {
	fields := []string{"schemaVersion", "protocolVersion", "generation", "sealedSegments", "activeSegment"}
	generation := integerField(value, "generation")
	if !exactFields(value, fields...) || value["schemaVersion"] != json.Number("1") ||
		value["protocolVersion"] != json.Number("2") ||
		generation < 1 ||
		segmentGeneration(stringField(value, "activeSegment"), activeSegmentPattern) != generation {
		return fmt.Errorf("lifecycle: несовместимый manifest")
	}
	segments, ok := value["sealedSegments"].([]any)
	if !ok || len(segments) > 4096 {
		return fmt.Errorf("lifecycle: неверный список sealedSegments")
	}
	var previous int64
	var previousHash any
	for _, item := range segments {
		descriptor, _ := item.(record)
		current := integerField(descriptor, "generation")
		if err := verifyDescriptor(descriptor); err != nil {
			return err
		}
		if current <= previous || current >= generation ||
			descriptor["previousSegmentSha256"] != previousHash {
			return fmt.Errorf("lifecycle: нарушена цепочка поколений")
		}
		previous, previousHash = current, descriptor["contentSha256"]
	}
	return nil
}

// verifyDescriptor проверяет форму и границу размера до чтения сегмента.
// Содержимое сверяется отдельно с полным набором вычисленных полей.
func verifyDescriptor(value record) error {
	fields := []string{
		"name", "generation", "byteLength", "eventCount", "firstSequence", "lastSequence",
		"basePreviousEventHash", "firstEventHash", "lastEventHash", "contentSha256", "previousSegmentSha256",
	}
	if !exactFields(value, fields...) {
		return fmt.Errorf("lifecycle: неверная форма sealed descriptor")
	}
	generation := segmentGeneration(stringField(value, "name"), sealedSegmentPattern)
	length := integerField(value, "byteLength")
	first, last, count := integerField(value, "firstSequence"), integerField(value, "lastSequence"),
		integerField(value, "eventCount")
	if generation == 0 || generation != integerField(value, "generation") ||
		length < 1 || length > lifecycleSegmentLimit || first < 1 || count < 1 || last-first+1 != count {
		return fmt.Errorf("lifecycle: неверный sealed descriptor")
	}
	for _, key := range []string{"firstEventHash", "lastEventHash", "contentSha256"} {
		if !digestPattern.MatchString(stringField(value, key)) {
			return fmt.Errorf("lifecycle: неверный хэш sealed %s", key)
		}
	}
	for _, key := range []string{"basePreviousEventHash", "previousSegmentSha256"} {
		if value[key] != nil && !digestPattern.MatchString(stringField(value, key)) {
			return fmt.Errorf("lifecycle: неверный хэш предка %s", key)
		}
	}
	return nil
}

// segmentGeneration извлекает только штатно записанный номер поколения.
// Нулевая или нераспознанная ревизия недопустима в manifest.
func segmentGeneration(name string, pattern *regexp.Regexp) int64 {
	parts := pattern.FindStringSubmatch(name)
	if parts == nil {
		return 0
	}
	generation, _ := strconv.ParseInt(parts[1], 10, 64)
	return generation
}

// loadSegment проверяет байты одной ревизии и добавляет их в общую последовательность.
// Sealed обязан завершаться LF, активный хвост лишь обнаруживается.
func (l *lifecycleState) loadSegment(
	root *os.Root, name string, descriptor record, seen map[string]bool,
) error {
	mode := ownerMode
	if descriptor != nil {
		mode = immutableMode
	}
	raw, err := readTrusted(root, filepath.Join("segments", name), lifecycleSegmentLimit, mode)
	if err != nil {
		return err
	}
	start := len(l.events)
	boundary := bytes.LastIndexByte(raw, '\n') + 1
	if descriptor != nil && (boundary == 0 || boundary != len(raw)) {
		return fmt.Errorf("lifecycle: оборванный sealed сегмент")
	}
	valid, remainder := raw[:boundary], raw[boundary:]
	for len(valid) != 0 {
		line, rest, _ := bytes.Cut(valid, []byte{'\n'})
		prev := l.previous()
		event, err := parseLifecycleLine(line, l.identity, int64(len(l.events)+1), prev)
		if err != nil {
			return err
		}
		id := stringField(event.Data, "eventId")
		if seen[id] {
			return fmt.Errorf("lifecycle: повтор стабильного eventId")
		}
		seen[id] = true
		event.Line = valid[:len(line)+1]
		l.events = append(l.events, event)
		valid = rest
	}
	if descriptor != nil {
		generation := integerField(descriptor, "generation")
		previous := descriptor["previousSegmentSha256"]
		observed := makeSealedDescriptor(generation, raw, l.events[start:], previous)
		if !reflect.DeepEqual(observed, descriptor) {
			return fmt.Errorf("lifecycle: sealed descriptor не совпадает с байтами")
		}
	} else {
		l.activeRaw, l.validActive, l.torn = raw, raw[:boundary], remainder
	}
	return nil
}

// parseLifecycleLine подтверждает схему, каноническую строку и родительский хэш.
// Принадлежность task/attempt не выводится из незакреплённых полей события.
func parseLifecycleLine(line []byte, identity Attempt, number int64, parent any) (LifecycleEvent, error) {
	if len(line) == 0 || len(line)+1 > lifecycleLineLimit {
		return LifecycleEvent{}, fmt.Errorf("lifecycle: недопустимая длина строки")
	}
	value, err := parseLifecycleRecord(line, lifecycleLineLimit)
	if err != nil {
		return LifecycleEvent{}, err
	}
	if err := validateLifecycleSchema(value); err != nil {
		return LifecycleEvent{}, err
	}
	encoded, err := lifecycleBytes(value, lifecycleLineLimit)
	if err != nil || !bytes.Equal(encoded, line) {
		return LifecycleEvent{}, fmt.Errorf("lifecycle: строка записана не канонически")
	}
	if value["taskId"] != "t"+identity.Task || value["attemptId"] != identity.ID ||
		integerField(value, "sequence") != number || value["previousEventHash"] != parent {
		return LifecycleEvent{}, fmt.Errorf("lifecycle: изменились identity, sequence или previousEventHash")
	}
	hash, err := lifecycleEventHash(value)
	if err != nil || value["eventHash"] != hash {
		return LifecycleEvent{}, fmt.Errorf("lifecycle: хэш события не совпадает")
	}
	return LifecycleEvent{Hash: hash, Data: value}, nil
}

// lifecycleEventHash вычисляет SHA-256 без самого поля eventHash.
// Для остальной оболочки применяется отдельная UTF-16 сортировка.
func lifecycleEventHash(value record) (string, error) {
	preimage := maps.Clone(value)
	delete(preimage, "eventHash")
	encoded, err := lifecycleBytes(preimage, lifecycleLineLimit)
	if err != nil {
		return "", err
	}
	return digestOf(encoded), nil
}

func (l lifecycleState) previous() any {
	if len(l.events) == 0 {
		return nil
	}
	return l.events[len(l.events)-1].Hash
}

// makeSealedDescriptor материализует описание точных raw bytes поколения.
// Идентичность первого и последнего событий берётся из проверенной цепочки.
func makeSealedDescriptor(generation int64, raw []byte, events []LifecycleEvent, previousHash any) record {
	if len(events) == 0 {
		return nil
	}
	first, last := events[0], events[len(events)-1]
	return record{
		"name": fmt.Sprintf("sealed-%016d.ndjson", generation), "generation": wireNumber(generation),
		"byteLength": wireNumber(int64(len(raw))), "eventCount": wireNumber(int64(len(events))),
		"firstSequence": first.Data["sequence"], "lastSequence": last.Data["sequence"],
		"basePreviousEventHash": first.Data["previousEventHash"], "firstEventHash": first.Hash,
		"lastEventHash": last.Hash, "contentSha256": digestOf(raw), "previousSegmentSha256": previousHash,
	}
}

func wireNumber(value int64) json.Number {
	return json.Number(strconv.FormatInt(value, 10))
}

var lifecycleSpan = map[string]string{
	"orchestrator_session_started":  "orchestrator_session",
	"orchestrator_session_finished": "orchestrator_session",
	"sandbox_started":               "sandbox", "sandbox_finished": "sandbox",
	"bootstrap_started": "bootstrap", "bootstrap_finished": "bootstrap",
	"node_visit_started": "node_visit", "node_visit_finished": "node_visit",
	"node_execution_started": "node_execution", "node_execution_finished": "node_execution",
	"command_started": "command", "command_finished": "command",
	"dispatch_started": "dispatch", "dispatch_finished": "dispatch",
	"runner_started": "runner", "runner_finished": "runner", "runner_abandoned": "runner",
	"gate_wait_started": "gate_wait", "gate_decided": "gate_wait",
	"human_intervention_started": "human_intervention", "human_intervention_resolved": "human_intervention",
	"cleanup_started": "cleanup", "cleanup_finished": "cleanup",
}

// verifyLifecycleScopes сверяет идентичность начала и конца живущих дольше процесса сущностей.
// После route_selected все следующие события относятся к одному закреплённому маршруту.
func verifyLifecycleScopes(events []LifecycleEvent, attempt Attempt) error {
	identities := make(map[string][]any)
	var selected [2]string
	for _, event := range events {
		value := event.Data
		if value["profile"] != attempt.Profile {
			return fmt.Errorf("lifecycle: профиль попытки изменился")
		}
		seen := [2]string{stringField(value, "routeId"), stringField(value, "routeHash")}
		if value["kind"] == "route_selected" {
			if selected[0] != "" || seen[0] == "" || (attempt.RouteID != "" &&
				seen != [2]string{attempt.RouteID, attempt.RouteHash}) {
				return fmt.Errorf("lifecycle: изменилось immutable route pin")
			}
			selected = seen
		} else if seen != selected {
			return fmt.Errorf("lifecycle: профилирование route до pin или смена pin")
		}
		for scope, identity := range lifecycleScopes(value) {
			if previous, present := identities[scope]; present && !reflect.DeepEqual(previous, identity) {
				return fmt.Errorf("lifecycle: изменился родительский scope %s", strings.Split(scope, "/")[0])
			}
			identities[scope] = identity
		}
	}
	return nil
}

// lifecycleScopes возвращает стабильные идентичности visit, execution, dispatch, run и span.
// Спаны ожидания человека могут продолжаться в новой сессии оркестратора.
func lifecycleScopes(event record) map[string][]any {
	routes := []any{event["routeId"], event["routeHash"]}
	node := []any{event["nodeId"], event["runKey"]}
	visit, execution := event["nodeVisitId"], event["nodeExecutionId"]
	dispatch, run := event["dispatchId"], event["runId"]
	epoch := event["epoch"]
	result := make(map[string][]any)
	if visit != nil {
		result["nodeVisitId/"+visit.(string)] = slices.Concat(routes, node)
	}
	if execution != nil {
		result["nodeExecutionId/"+execution.(string)] = slices.Concat(routes, []any{visit}, node)
	}
	if dispatch != nil {
		result["dispatchId/"+dispatch.(string)] = slices.Concat(routes, []any{visit, execution}, node)
	}
	if run != nil {
		key := fmt.Sprintf("run/%s/%v", run, epoch)
		result[key] = slices.Concat(routes, []any{visit, execution}, node, []any{dispatch})
	}
	if span := event["spanId"]; span != nil {
		family := lifecycleSpan[stringField(event, "kind")]
		session := event["orchestratorSessionId"]
		switch family {
		case "orchestrator_session", "sandbox", "bootstrap", "cleanup":
			routes = []any{nil, nil}
		case "node_visit", "gate_wait", "human_intervention":
			session = nil
		}
		result["spanId/"+span.(string)] = slices.Concat([]any{family}, routes,
			[]any{session, visit, execution}, node, []any{dispatch, run, epoch})
	}
	return result
}
