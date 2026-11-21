package state

import (
	"fmt"
	"maps"
	"strconv"
	"time"
)

// PauseStage отмечает ожидание человека на exact head.
// Готовый повтор того же ожидания возвращает существующий cursor.
func (s Store) PauseStage(task, id string, expected StageSnapshot, reason string) (StageSnapshot, error) {
	if !attemptPattern.MatchString(id) || !validReason(reason) {
		return StageSnapshot{}, fmt.Errorf("stage: нужна точная попытка и причина ожидания")
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
	if err != nil {
		return StageSnapshot{}, err
	}
	current := ledger.snapshot()
	if current != expected {
		return StageSnapshot{}, fmt.Errorf("%w: FACTORY_ERROR=stale_stage", ErrConflict)
	}
	before := objectField(ledger.pointer, "cursor")
	if current.State == "paused" && before["pauseReason"] == reason {
		return current, nil
	}
	if current.State != "ready" {
		return StageSnapshot{}, fmt.Errorf("%w: cursor не готов к ожиданию", ErrConflict)
	}
	sequence := current.Sequence + 1
	event := ledger.identity()
	maps.Copy(event, record{
		"sequence": wireNumber(sequence), "at": time.Now().UTC().Format(time.RFC3339),
		"kind": "pause", "node": current.CurrentNode, "outcome": nil, "reason": reason,
		"action": nil, "previousEventHash": current.HeadEventHash, "before": before,
		"after": makeCursor("paused", current.CurrentNode, nil, reason, before["lastCommit"]),
	})
	if err := ledger.validateEvent(event, before, current.HeadEventHash, sequence); err != nil {
		return StageSnapshot{}, err
	}
	return ledger.append(dir, event, true, publishFile)
}

// StageResults строит строки evidence из подтверждённой цепочки.
// Содержимое пользовательской проекции не входит в этот список.
func (s Store) StageResults(task, id string) ([]string, error) {
	if !attemptPattern.MatchString(id) {
		return nil, fmt.Errorf("stage: нужна точная попытка")
	}
	t, err := s.openTask(task, false)
	if err != nil {
		return nil, err
	}
	defer t.close()
	ledger, dir, err := t.loadStage(task, id, false)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return nil, err
	}
	var result []string
	for i, event := range ledger.events {
		outcome := stringField(event.Data, "outcome")
		if i > 0 && outcome != "" {
			result = append(result, stringField(event.Data, "node")+":"+outcome+":"+strconv.Itoa(i))
		}
	}
	return result, nil
}

// ReadStageTail возвращает последний event только для заново подтверждённого head.
// Caller получает оригинальные байты и не может менять их через API.
func (s Store) ReadStageTail(task, id, expected string) (StageEvent, error) {
	if !attemptPattern.MatchString(id) || !digestPattern.MatchString(expected) {
		return StageEvent{}, fmt.Errorf("stage: нужен exact head")
	}
	t, err := s.openTask(task, false)
	if err != nil {
		return StageEvent{}, err
	}
	defer t.close()
	ledger, dir, err := t.loadStage(task, id, false)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return StageEvent{}, err
	}
	last := ledger.events[len(ledger.events)-1]
	if last.Hash != expected {
		return StageEvent{}, fmt.Errorf("%w: head сменился", ErrConflict)
	}
	return last, nil
}
