package state

import (
	"bytes"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

const lifecycleDefaultTarget = 16 * 1024 * 1024

// InitLifecycle публикует начальное поколение при первом открытии попытки.
// Manifest фиксируется только после синхронизации сегмента и его каталога.
func (s Store) InitLifecycle(task, id string) error {
	dir, err := s.openLifecycle(task, id, true, true)
	if err != nil {
		return err
	}
	defer dir.close()
	for _, name := range []string{"segments", "quarantine", "usage"} {
		if err := ensurePrivateDirectory(dir.root, name, true); err != nil {
			return err
		}
	}
	if _, err := dir.root.Lstat("manifest.json"); errors.Is(err, os.ErrNotExist) {
		const name = "active-0000000000000001.ndjson"
		segment := filepath.Join("segments", name)
		if err := publishLifecycleBytes(dir.root, segment, nil, ownerMode); err != nil {
			return err
		}
		if err := publishLifecycleManifest(dir.root, lifecycleManifest(1, name, []any{}), nil); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	ledger, err := loadLifecycle(dir.root, dir.identity)
	if err != nil {
		return err
	}
	if len(ledger.torn) != 0 {
		return ErrLifecycleIncomplete
	}
	return ledger.writeTail(dir.root)
}

// AppendLifecycle принимает новый draft либо подтверждает идемпотентный повтор его id.
// В случае оборванного активного хвоста исходные байты остаются в карантине.
func (s Store) AppendLifecycle(task, id string, draftBytes []byte, segmentTarget int) (string, error) {
	if segmentTarget == 0 {
		segmentTarget = lifecycleDefaultTarget
	}
	if segmentTarget < 1 || segmentTarget > lifecycleSegmentLimit {
		return "", fmt.Errorf("lifecycle: неверный предел сегмента")
	}
	draft, err := parseLifecycleRecord(draftBytes, lifecycleLineLimit)
	if err != nil {
		return "", err
	}
	if err := validateLifecycleDraft(draft, task, id); err != nil {
		return "", err
	}
	dir, err := s.openLifecycle(task, id, true, false)
	if err != nil {
		return "", err
	}
	defer dir.close()
	ledger, err := loadLifecycle(dir.root, dir.identity)
	if err != nil {
		return "", err
	}
	if len(ledger.torn) != 0 {
		ledger, err = ledger.recoverTail(dir.root, draft)
		if err != nil {
			return "", err
		}
	}
	for _, previous := range ledger.events {
		if previous.Data["eventId"] == draft["eventId"] {
			if !reflect.DeepEqual(draft, lifecycleDraft(previous.Data)) {
				return "", ErrLifecycleEventID
			}
			return previous.Hash, ledger.writeTail(dir.root)
		}
	}
	return ledger.append(dir.root, draft, segmentTarget)
}

// validateLifecycleDraft исключает поля цепочки, которыми владеет writer.
// Типы и identity проверяются до открытия изменяемого журнала.
func validateLifecycleDraft(draft record, task, id string) error {
	for _, key := range []string{"sequence", "previousEventHash", "eventHash"} {
		if hasRecordField(draft, key) {
			return fmt.Errorf("lifecycle: поле %s относится к writer", key)
		}
	}
	if draft["taskId"] != "t"+task || draft["attemptId"] != id ||
		draft["kind"] == "lifecycle_tail_recovered" {
		return fmt.Errorf("lifecycle: недопустимая identity черновика")
	}
	_, err := sealLifecycle(draft, 1, nil)
	return err
}

func lifecycleDraft(event record) record {
	result := maps.Clone(event)
	for _, key := range []string{"sequence", "previousEventHash", "eventHash"} {
		delete(result, key)
	}
	return result
}

// sealLifecycle добавляет chain fields и строит одну физическую строку.
// Предыдущий хэш берётся из прочитанного журнала, а не из входа пользователя.
func sealLifecycle(draft record, sequence int64, previous any) (LifecycleEvent, error) {
	event := maps.Clone(draft)
	event["sequence"], event["previousEventHash"] = wireNumber(sequence), previous
	hash, err := lifecycleEventHash(event)
	if err != nil {
		return LifecycleEvent{}, err
	}
	event["eventHash"] = hash
	if err := validateLifecycleSchema(event); err != nil {
		return LifecycleEvent{}, err
	}
	line, err := lifecycleBytes(event, lifecycleLineLimit-1)
	if err != nil {
		return LifecycleEvent{}, err
	}
	return LifecycleEvent{Hash: hash, Line: append(line, '\n'), Data: event}, nil
}

// append повторно проверяет scope новой строки вместе с принятой историей.
// После sync перечитывается фактически выбранное поколение.
func (l lifecycleState) append(root *os.Root, draft record, target int) (string, error) {
	event, err := sealLifecycle(draft, int64(len(l.events)+1), l.previous())
	if err != nil {
		return "", err
	}
	if err := verifyLifecycleScopes(append(slices.Clone(l.events), event), l.identity); err != nil {
		return "", err
	}
	if len(l.activeRaw) != 0 && len(l.activeRaw)+len(event.Line) > target {
		err = l.rotate(root, event.Line)
	} else {
		err = l.appendActive(root, event.Line)
	}
	if err != nil {
		return "", err
	}
	accepted, err := loadLifecycle(root, l.identity)
	if err != nil {
		return "", err
	}
	if len(accepted.torn) != 0 || accepted.previous() != event.Hash {
		return "", fmt.Errorf("lifecycle: запись не стала проверенным хвостом")
	}
	return event.Hash, accepted.writeTail(root)
}

// appendActive проверяет физическую идентичность сегмента непосредственно перед записью.
// Длинный активный сегмент остаётся в пределах жёсткого лимита.
func (l lifecycleState) appendActive(root *os.Root, line []byte) error {
	name := filepath.Join("segments", stringField(l.manifest, "activeSegment"))
	before, err := root.Lstat(name)
	if err != nil {
		return err
	}
	if err := l.verifyUnchanged(root); err != nil {
		return err
	}
	file, err := host.OpenAt(root, name, os.O_WRONLY|os.O_APPEND, 0, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !host.FileOwner(file, info) || !host.SingleLink(file, info) ||
		!ownerMode.accepts(file, info) || !os.SameFile(before, info) ||
		before.ModTime() != info.ModTime() || info.Size() != int64(len(l.activeRaw)) {
		return fmt.Errorf("lifecycle: изменился физический active segment")
	}
	if info.Size()+int64(len(line)) > lifecycleSegmentLimit {
		return fmt.Errorf("lifecycle: превышен предел active segment")
	}
	if _, err := file.Write(line); err != nil {
		return err
	}
	return file.Sync()
}

// rotate сохраняет байты активного поколения в sealed и создаёт следующий active.
// При повторе после сбоя допускаются прежние точные байты до CAS manifest.
func (l lifecycleState) rotate(root *os.Root, line []byte) error {
	generation := integerField(l.manifest, "generation")
	sealed := arrayField(l.manifest, "sealedSegments")
	var previous any
	if len(sealed) > 0 {
		last, _ := sealed[len(sealed)-1].(record)
		previous = last["contentSha256"]
	}
	descriptor := makeSealedDescriptor(generation, l.activeRaw, l.events[l.activeFrom:], previous)
	name := filepath.Join("segments", stringField(descriptor, "name"))
	if err := publishLifecycleBytes(root, name, l.activeRaw, immutableMode); err != nil {
		return err
	}
	return l.activate(root, append(slices.Clone(sealed), descriptor), line)
}

// activate публикует следующее физическое поколение перед manifest CAS.
// Предыдущее поколение остаётся доступным до полного изменения manifest.
func (l lifecycleState) activate(root *os.Root, sealed []any, data []byte) error {
	generation := integerField(l.manifest, "generation") + 1
	if generation > lifecycleIntegerMax {
		return fmt.Errorf("lifecycle: переполнение номера поколения")
	}
	active := fmt.Sprintf("active-%016d.ndjson", generation)
	if err := publishLifecycleBytes(root, filepath.Join("segments", active), data, ownerMode); err != nil {
		return err
	}
	if err := l.verifyUnchanged(root); err != nil {
		return err
	}
	return publishLifecycleManifest(root, lifecycleManifest(generation, active, sealed), l.manifestRaw)
}

// recoverTail сохраняет исходный сегмент и создаёт детерминированное событие восстановления.
// Замена поколения отбрасывает только неполный остаток, сохраняя принятые строки.
func (l lifecycleState) recoverTail(root *os.Root, pending record) (lifecycleState, error) {
	sourceHash := digestOf(l.activeRaw)
	if err := publishLifecycleBytes(root, filepath.Join("quarantine", sourceHash+".ndjson"),
		l.activeRaw, ownerMode); err != nil {
		return l, err
	}
	draft := l.recoveryDraft(pending, sourceHash)
	event, err := sealLifecycle(draft, int64(len(l.events)+1), l.previous())
	if err != nil {
		return l, err
	}
	data := append(bytes.Clone(l.validActive), event.Line...)
	if err := l.activate(root, arrayField(l.manifest, "sealedSegments"), data); err != nil {
		return l, err
	}
	recovered, err := loadLifecycle(root, l.identity)
	if err != nil {
		return l, err
	}
	if recovered.previous() != event.Hash || len(recovered.torn) != 0 {
		return l, fmt.Errorf("lifecycle: восстановленное поколение не совпало")
	}
	return recovered, recovered.writeTail(root)
}

// recoveryDraft копирует ровно scope прежней принятой цепочки.
// Хэш исходного сегмента и длина префикса определяют стабильный eventId.
func (l lifecycleState) recoveryDraft(pending record, sourceHash string) record {
	base := pending
	if len(l.events) != 0 {
		base = l.events[len(l.events)-1].Data
	}
	seed := fmt.Sprintf("lifecycle_tail_recovered\x00%s\x00%d", sourceHash, len(l.validActive))
	draft := record{
		"schemaVersion": wireNumber(1), "protocolVersion": wireNumber(2),
		"eventId": "ev_" + digestOf([]byte(seed))[:32], "at": pending["at"],
		"taskId": pending["taskId"], "attemptId": pending["attemptId"], "profile": base["profile"],
		"routeId": base["routeId"], "routeHash": base["routeHash"],
		"orchestratorSessionId": base["orchestratorSessionId"], "nodeVisitId": nil,
		"nodeExecutionId": nil, "nodeId": nil, "runKey": nil, "dispatchId": nil,
		"runId": nil, "epoch": nil, "spanId": nil, "kind": "lifecycle_tail_recovered",
		"writerVersion": "attempt-lifecycle-state/1", "clock": pending["clock"],
		"details": record{
			"sourceSegmentSha256": sourceHash, "validBytes": wireNumber(int64(len(l.validActive))),
			"discardedBytes": wireNumber(int64(len(l.torn))), "lastValidEventHash": l.previous(),
		},
	}
	return draft
}

// verifyUnchanged сравнивает захваченные байты manifest и активного файла.
// В частности, ротация не затрёт более поздний результат старого писателя.
func (l lifecycleState) verifyUnchanged(root *os.Root) error {
	manifest, err := readTrusted(root, "manifest.json", metadataBytes, ownerMode)
	if err != nil || !bytes.Equal(manifest, l.manifestRaw) {
		return fmt.Errorf("%w: lifecycle manifest изменился", ErrConflict)
	}
	name := filepath.Join("segments", stringField(l.manifest, "activeSegment"))
	active, err := readTrusted(root, name, lifecycleSegmentLimit, ownerMode)
	if err != nil || !bytes.Equal(active, l.activeRaw) {
		return fmt.Errorf("%w: active segment изменился", ErrConflict)
	}
	return nil
}

func lifecycleManifest(generation int64, active string, sealed []any) record {
	return record{
		"schemaVersion": wireNumber(1), "protocolVersion": wireNumber(2),
		"generation":    wireNumber(generation),
		"activeSegment": active, "sealedSegments": sealed,
	}
}

// publishLifecycleManifest делает CAS над сырыми байтами исторического manifest.
// Отсутствующий manifest допускается только при первичном init.
func publishLifecycleManifest(root *os.Root, manifest record, previous []byte) error {
	if previous != nil {
		actual, err := readTrusted(root, "manifest.json", metadataBytes, ownerMode)
		if err != nil || !bytes.Equal(previous, actual) {
			return fmt.Errorf("%w: lifecycle manifest изменился", ErrConflict)
		}
	}
	data, err := lifecycleBytes(manifest, metadataBytes)
	if err != nil {
		return err
	}
	return publishFile(root, "manifest.json", append(data, '\n'), ownerMode, previous != nil)
}

// publishLifecycleBytes подтверждает идентичность уже опубликованного файла.
// Повтор после сбоя переиспользует только точные байты и режим.
func publishLifecycleBytes(root *os.Root, name string, data []byte, mode fsMode) error {
	previous, err := readTrusted(root, name, lifecycleSegmentLimit, mode)
	if errors.Is(err, os.ErrNotExist) {
		return publishFile(root, name, data, mode, false)
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(previous, data) {
		return fmt.Errorf("%w: разные байты сегмента %s", ErrConflict, name)
	}
	return nil
}

// writeTail обновляет только производную витрину после подтверждения цепочки.
// Самостоятельно tail никогда не используется как источник права записи.
func (l lifecycleState) writeTail(root *os.Root) error {
	value := record{
		"schemaVersion": wireNumber(1), "protocolVersion": wireNumber(2),
		"generation":    l.manifest["generation"],
		"activeSegment": l.manifest["activeSegment"], "byteLength": wireNumber(int64(len(l.activeRaw))),
		"sequence": wireNumber(int64(len(l.events))), "eventHash": l.previous(),
	}
	data, err := lifecycleBytes(value, lifecycleLineLimit)
	if err != nil {
		return err
	}
	return publishFile(root, "tail.json", append(data, '\n'), ownerMode, true)
}
