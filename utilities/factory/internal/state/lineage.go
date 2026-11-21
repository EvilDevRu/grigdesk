package state

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"syscall"
)

const lineageBytesLimit = 64 * 1024

//go:embed schema/provider-lineage.schema.json
var lineageSchema []byte

var loadLineageContract = sync.OnceValues(func() (lifecycleContract, error) {
	return parseLifecycleContract(lineageSchema)
})

var (
	ErrLineagePayload  = errors.New("provider-lineage-payload-conflict")
	ErrLineageConsumed = errors.New("provider-lineage-predecessor-consumed")
)

var predecessorFields = map[string]string{
	"predecessorUsageDocumentHash":            "usageDocumentHash",
	"predecessorCheckpointHash":               "checkpointHash",
	"predecessorRunnerUsageRecordedEventHash": "runnerUsageRecordedEventHash",
	"predecessorScopeBoundEventHash":          "runnerScopeBoundEventHash",
}

type lineageDir struct {
	root *os.Root
	lock *os.File
	name string
	hash string
}

func (d lineageDir) close() {
	d.lock.Close()
	d.root.Close()
}

// ReadLineage проверяет запись в отдельном CAS-хранилище провайдеров.
// Сырой threadId никогда не используется в пути файла.
func (s Store) ReadLineage(provider, thread string) (map[string]any, error) {
	dir, err := s.openLineage(provider, thread, false)
	if err != nil {
		return nil, err
	}
	defer dir.close()
	value, _, err := dir.read()
	return value, err
}

// ChangeLineage применяет разрешённый переход после проверки локальной схемы.
// Повтор с тем же ключом и доказательством доводит fsync, не меняя revision.
func (s Store) ChangeLineage(operation string, raw []byte) (map[string]any, error) {
	request, err := parseLifecycleRecord(raw, lineageBytesLimit)
	if err != nil {
		return nil, err
	}
	schema, err := loadLineageContract()
	if err != nil {
		return nil, err
	}
	if !schema.matches(request, objectField(schema.refs, operation+"Request")) {
		return nil, fmt.Errorf("provider-lineage-schema-invalid: неверный запрос %s", operation)
	}
	provider, thread := stringField(request, "provider"), stringField(request, "threadId")
	dir, err := s.openLineage(provider, thread, true)
	if err != nil {
		return nil, err
	}
	defer dir.close()
	current, before, err := dir.read()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	next, err := changeLineageRecord(operation, current, request, dir.hash)
	if err != nil {
		return nil, err
	}
	if err := validateLineageRecord(next, dir.hash); err != nil {
		return nil, err
	}
	if reflect.DeepEqual(current, next) {
		return current, syncDirectory(dir.root, ".")
	}
	if err := dir.publish(next, before); err != nil {
		return nil, err
	}
	return next, nil
}

// openLineage открывает исторический scope lock на приватном каталоге.
// Создание дополнительных путей разрешено только операции изменения.
func (s Store) openLineage(provider, thread string, write bool) (lineageDir, error) {
	dir := lineageDir{}
	schema, err := loadLineageContract()
	if err != nil {
		return dir, err
	}
	if !schema.matches(provider, objectField(schema.refs, "provider")) ||
		!schema.matches(thread, objectField(schema.refs, "threadId")) || len(thread) > 512 {
		return dir, fmt.Errorf("provider-lineage-schema-invalid: неверный scope")
	}
	identity, err := lifecycleBytes(record{"provider": provider, "threadId": thread}, lineageBytesLimit)
	if err != nil {
		return dir, err
	}
	dir.hash = digestOf(identity)
	dir.name = dir.hash + ".json"
	control, err := openControl(s.ControlDir, write)
	if err != nil {
		return dir, err
	}
	defer control.Close()
	path := ""
	for _, part := range []string{"protocol-v2", "provider-lineage", "schema-1", provider} {
		path = filepath.Join(path, part)
		if err := ensurePrivateDirectory(control, path, write); err != nil {
			return dir, err
		}
	}
	root, err := control.OpenRoot(path)
	if err != nil {
		return dir, err
	}
	lockName := dir.hash + ".lock"
	if err := ensurePrivateDirectory(root, lockName, write); err != nil {
		root.Close()
		return dir, err
	}
	lock, err := root.OpenFile(lockName, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_DIRECTORY, 0)
	if err != nil {
		root.Close()
		return dir, err
	}
	operation := syscall.LOCK_SH
	if write {
		operation = syscall.LOCK_EX
	}
	if err := flock(lock, operation); err != nil {
		lock.Close()
		root.Close()
		return dir, err
	}
	dir.root, dir.lock = root, lock
	return dir, nil
}

// read сверяет физический файл и смысл текущего состояния CAS.
// Соседний scope не может подменить проверяемую запись.
func (d lineageDir) read() (record, []byte, error) {
	raw, err := readTrusted(d.root, d.name, lineageBytesLimit, ownerMode)
	if err != nil {
		return nil, nil, err
	}
	value, err := parseLifecycleRecord(raw, lineageBytesLimit)
	if err != nil {
		return nil, nil, err
	}
	encoded, err := lifecycleBytes(value, lineageBytesLimit)
	if err != nil || !bytes.Equal(raw, append(encoded, '\n')) {
		return nil, nil, fmt.Errorf("provider-lineage-schema-invalid: запись не каноническая")
	}
	if err := validateLineageRecord(value, d.hash); err != nil {
		return nil, nil, err
	}
	return value, raw, nil
}

// validateLineageRecord дополняет JSON schema сравнениями связанных полей.
// Проверенный scope и принадлежность successor не выводятся из одного state.
func validateLineageRecord(value record, scope string) error {
	contract, err := loadLineageContract()
	if err != nil || !contract.matches(value, contract.schema) {
		return fmt.Errorf("provider-lineage-schema-invalid: неверная запись")
	}
	provider, thread := stringField(value, "provider"), stringField(value, "threadId")
	encoded, err := lifecycleBytes(record{"provider": provider, "threadId": thread}, lineageBytesLimit)
	if err != nil || len(thread) > 512 || digestOf(encoded) != scope || value["scopeSha256"] != scope {
		return fmt.Errorf("provider-lineage-scope-conflict: несовместимое закрепление")
	}
	if (value["predecessorRunId"] == value["childRunId"]) != (value["state"] == "advanced") {
		return fmt.Errorf("provider-lineage-schema-invalid: неверный successor")
	}
	return nil
}

// publish проверяет прежние байты непосредственно перед заменой.
// Другой stateRevision в том же scope не может потеряться при CAS.
func (d lineageDir) publish(value record, original []byte) error {
	if original != nil {
		raw, err := readTrusted(d.root, d.name, lineageBytesLimit, ownerMode)
		if err != nil || !bytes.Equal(original, raw) {
			return fmt.Errorf("%w: provider-lineage-cas-conflict", ErrConflict)
		}
	}
	data, err := lifecycleBytes(value, lineageBytesLimit)
	if err != nil {
		return err
	}
	return publishFile(d.root, d.name, append(data, '\n'), ownerMode, original != nil)
}

// changeLineageRecord определяет единственный переход либо точный replay.
// Ошибка никогда не выдаёт повторному запуску уже потреблённый predecessor.
func changeLineageRecord(operation string, old, request record, scope string) (record, error) {
	if operation == "initialize" {
		wanted := initialLineage(request, scope)
		if old == nil || reflect.DeepEqual(old, wanted) {
			return wanted, nil
		}
		return nil, ErrLineagePayload
	}
	if old == nil {
		return nil, fmt.Errorf("provider-lineage-not-found")
	}
	if operation == "reserve" {
		return reserveLineage(old, request)
	}
	return resolveLineage(operation, old, request)
}

// initialLineage закрепляет generation=0 и полный eligible checkpoint.
// У свежего predecessor и current child один runId.
func initialLineage(request record, scope string) record {
	result := record{
		"schemaVersion": wireNumber(1), "protocolVersion": wireNumber(2),
		"provider": request["provider"], "threadId": request["threadId"], "scopeSha256": scope,
		"stateRevision": wireNumber(1), "lineageGeneration": wireNumber(0), "state": "advanced",
		"reservationId": nil, "predecessorRunId": request["runId"], "childRunId": request["runId"],
		"runnerStartedEventHash": nil, "cancellationProof": nil, "blockProof": nil,
		"writerVersion": "provider-lineage-state/1",
	}
	for key, source := range predecessorFields {
		result[key] = request[source]
	}
	return result
}

// reserveLineage допускает одного successor для ещё не потреблённого predecessor.
// Отменённая reservation требует нового id и другой childRunId.
func reserveLineage(old, req record) (record, error) {
	oldState := stringField(old, "state")
	revision := integerField(req, "expectedStateRevision")
	prior := []string{"predecessorRunId", "predecessorUsageDocumentHash", "predecessorCheckpointHash"}
	samePredecessor := sameFields(old, req, prior...)
	if req["predecessorRunId"] == req["childRunId"] {
		return nil, fmt.Errorf("provider-lineage-schema-invalid: child и predecessor совпали")
	}
	if oldState == "reserved_before_start" {
		sameChild := sameFields(old, req, "reservationId", "childRunId", "lineageGeneration")
		if sameChild && samePredecessor && integerField(old, "stateRevision") == revision+1 {
			return old, nil
		}
		if old["reservationId"] == req["reservationId"] {
			return nil, ErrLineagePayload
		}
		return nil, ErrConflict
	}
	if oldState == "started" || oldState == "blocked_after_start" {
		return nil, ErrLineageConsumed
	}
	generation := integerField(old, "lineageGeneration")
	if oldState == "advanced" {
		generation++
	} else if old["childRunId"] == req["childRunId"] {
		return nil, ErrConflict
	}
	if !samePredecessor || old["reservationId"] == req["reservationId"] ||
		integerField(old, "stateRevision") != revision ||
		integerField(req, "lineageGeneration") != generation {
		return nil, ErrConflict
	}
	result := maps.Clone(old)
	maps.Copy(result, record{
		"state": "reserved_before_start", "stateRevision": wireNumber(revision + 1),
		"lineageGeneration": req["lineageGeneration"], "reservationId": req["reservationId"],
		"childRunId": req["childRunId"], "runnerStartedEventHash": nil,
		"cancellationProof": nil, "blockProof": nil,
	})
	return result, nil
}

type lineageMove struct {
	from, to string
	proof    string
}

var lineageMoves = map[string]lineageMove{
	"started": {"reserved_before_start", "started", "runnerStartedEventHash"},
	"cancel":  {"reserved_before_start", "cancelled_before_start", "cancellationProof"},
	"advance": {"started", "advanced", ""},
	"block":   {"started", "blocked_after_start", "blockProof"},
}

// resolveLineage переносит ровно тот child, который держит reservation.
// Cancellation не разрешена после пересечения стартового барьера.
func resolveLineage(operation string, old, req record) (record, error) {
	move, valid := lineageMoves[operation]
	if !valid {
		return nil, fmt.Errorf("provider-lineage-argument-invalid")
	}
	revision := integerField(req, "expectedStateRevision")
	current := stringField(old, "state")
	changes := lineageProofFields(operation, move, req)
	same := sameFields(old, req, "reservationId", "childRunId")
	if current == move.to && old["reservationId"] == req["reservationId"] {
		if same && integerField(old, "stateRevision") == revision+1 && containsFields(old, changes) {
			return old, nil
		}
		return nil, ErrLineagePayload
	}
	if current != move.from {
		if current == "advanced" || current == "blocked_after_start" ||
			(operation == "cancel" && current == "started") {
			return nil, ErrLineageConsumed
		}
		return nil, ErrConflict
	}
	if !same || integerField(old, "stateRevision") != revision {
		return nil, ErrConflict
	}
	result := maps.Clone(old)
	maps.Copy(result, changes)
	result["state"], result["stateRevision"] = move.to, wireNumber(revision+1)
	return result, nil
}

// lineageProofFields выбирает доказательство операции.
// Advance переносит checkpoint successor в качестве нового predecessor.
func lineageProofFields(operation string, move lineageMove, request record) record {
	if operation != "advance" {
		return record{move.proof: request[move.proof]}
	}
	result := record{"predecessorRunId": request["childRunId"], "cancellationProof": nil, "blockProof": nil}
	for key, source := range predecessorFields {
		result[key] = request[source]
	}
	return result
}

// sameFields сравнивает только объявленные поля одного ABI.
// Точные payload в доказательствах допускают вложенные объекты JSON.
func sameFields(a, b record, names ...string) bool {
	for _, name := range names {
		if !reflect.DeepEqual(a[name], b[name]) {
			return false
		}
	}
	return true
}

// containsFields проверяет exact replay перехода.
// Несвязанная часть старого документа не участвует в сравнении нового запроса.
func containsFields(value, fields record) bool {
	for name, expected := range fields {
		if !reflect.DeepEqual(value[name], expected) {
			return false
		}
	}
	return true
}
