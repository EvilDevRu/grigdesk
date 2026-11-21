package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"strconv"
	"time"
)

type StageCommit struct {
	Task, Attempt, Node, Outcome, ExpectedHead string
	ExpectedSequence                           int64
	Reason, FailureOwner                       string
	Verdict                                    map[string]any
	RewindLimit, NoProgressLimit, TargetBudget int64
	LoopMaxRounds                              int64
}

type stagePublisher func(*os.Root, string, []byte, fsMode, bool) error

// InitStage создаёт первый cursor закреплённого маршрута.
// Уже проверенная цепочка возвращается без добавления повторного init.
func (s Store) InitStage(task, id string) (StageSnapshot, error) {
	if !attemptPattern.MatchString(id) {
		return StageSnapshot{}, fmt.Errorf("stage: нужна точная попытка")
	}
	t, err := s.openTask(task, true)
	if err != nil {
		return StageSnapshot{}, err
	}
	defer t.close()
	ledger, dir, err := t.loadStage(task, id, true)
	if dir != nil {
		defer dir.Close()
	}
	if err == nil {
		return ledger.snapshot(), nil
	}
	if !errors.Is(err, ErrStageAbsent) || dir == nil {
		return StageSnapshot{}, err
	}
	event := ledger.identity()
	maps.Copy(event, record{
		"sequence": json.Number("0"), "at": time.Now().UTC().Format(time.RFC3339),
		"kind": "init", "node": ledger.entry, "outcome": nil, "reason": nil,
		"action": record{"next": ledger.entry}, "previousEventHash": nil,
		"before": nil, "after": makeCursor("ready", ledger.entry, nil, nil, nil),
	})
	return ledger.append(dir, event, false, publishFile)
}

// CommitStage атомарно подтверждает исход текущего узла на проверенном head.
// Действие берётся из закреплённой модели, а не из внешней проекции.
func (s Store) CommitStage(input StageCommit) (StageSnapshot, error) {
	return s.commitStage(input, publishFile)
}

// commitStage сохраняет порядок filesystem effects независимо от реализации writer.
// В тесте реальный publisher можно остановить на выбранной границе, не меняя production argv.
func (s Store) commitStage(input StageCommit, publish stagePublisher) (StageSnapshot, error) {
	if !attemptPattern.MatchString(input.Attempt) || !digestPattern.MatchString(input.ExpectedHead) ||
		input.ExpectedSequence < 0 || !stagePattern.MatchString(input.Node) {
		return StageSnapshot{}, fmt.Errorf("stage: нужны exact attempt и expected head")
	}
	t, err := s.openTask(input.Task, true)
	if err != nil {
		return StageSnapshot{}, err
	}
	defer t.close()
	ledger, dir, err := t.loadStage(input.Task, input.Attempt, true)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return StageSnapshot{}, err
	}
	current := ledger.snapshot()
	if current.Sequence != input.ExpectedSequence || current.HeadEventHash != input.ExpectedHead ||
		current.CurrentNode != input.Node || current.State == "stopped" {
		return StageSnapshot{}, fmt.Errorf("%w: FACTORY_ERROR=stale_stage", ErrConflict)
	}
	event, err := ledger.makeCommit(input)
	if err != nil {
		return StageSnapshot{}, err
	}
	return ledger.append(dir, event, true, publish)
}

// makeCommit строит документ очередного события без побочных операций.
// Before и родительский хэш принадлежат тому же snapshot под lock.
func (l stageLedger) makeCommit(input StageCommit) (record, error) {
	selected, err := l.bundle.Transition(input.Node, input.Outcome, input.FailureOwner)
	if err != nil {
		return nil, err
	}
	before, _ := l.pointer["cursor"].(record)
	event := l.identity()
	next := input.ExpectedSequence + 1
	maps.Copy(event, record{
		"at": time.Now().UTC().Format(time.RFC3339), "sequence": json.Number(strconv.FormatInt(next, 10)),
		"kind": "commit", "node": input.Node, "outcome": input.Outcome, "reason": nil,
		"action": selected["action"], "previousEventHash": input.ExpectedHead, "before": before,
	})
	if input.Reason != "" {
		event["reason"] = input.Reason
	}
	if input.Verdict != nil {
		event["verdict"] = input.Verdict
	}
	if err := l.assignRewindPolicy(event, input); err != nil {
		return nil, err
	}
	after, err := l.deriveCursor(event, before, next)
	if err != nil {
		return nil, err
	}
	event["after"] = after
	if err := l.validateEvent(event, before, input.ExpectedHead, next); err != nil {
		return nil, err
	}
	return event, nil
}

// append публикует raw event до перестановки runtime pointer.
// Сбой между фазами оставляет проверяемую цепочку для отдельного reconcile.
func (l stageLedger) append(
	dir *os.Root, event record, initialized bool, publish stagePublisher,
) (StageSnapshot, error) {
	raw, err := indentRecord(event)
	if err != nil {
		return StageSnapshot{}, err
	}
	hash := digestOf(raw)
	name := fmt.Sprintf("event.%020d.%s.json", len(l.events), hash)
	if err := publish(dir, name, raw, immutableMode, false); err != nil {
		return StageSnapshot{}, err
	}
	runtime := l.runtimeFrom(StageEvent{Raw: raw, Hash: hash, Data: event})
	if err := writeRuntimePointerWith(dir, runtime, initialized, publish); err != nil {
		return StageSnapshot{}, err
	}
	l.pointer = runtime
	return l.snapshot(), nil
}

// writeRuntimePointer публикует checksum только для уже принятого cursor.
// Событие и указатель синхронизируются отдельными физическими операциями.
func writeRuntimePointer(dir *os.Root, runtime record, initialized bool) error {
	return writeRuntimePointerWith(dir, runtime, initialized, publishFile)
}

// writeRuntimePointerWith кодирует тот же envelope для каждого publisher.
// Внешний writer не получает готовую .pipeline как подтверждение результата.
func writeRuntimePointerWith(dir *os.Root, runtime record, initialized bool, publish stagePublisher) error {
	checksum, err := compactRecord(runtime)
	if err != nil {
		return err
	}
	pointer, err := indentRecord(record{"runtime": runtime, "checksum": digestOf(checksum)})
	if err != nil {
		return err
	}
	return publish(dir, "runtime.json", pointer, immutableMode, initialized)
}
