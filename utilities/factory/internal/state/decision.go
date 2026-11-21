package state

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CommitGate проводит решение под тем же CAS, что остальные события.
// Повтор совпавшего решения над предыдущим head не добавляет второе событие.
func (s Store) CommitGate(input StageCommit) (StageSnapshot, bool, error) {
	if !attemptPattern.MatchString(input.Attempt) || !stagePattern.MatchString(input.Node) ||
		(input.Outcome != "approved" && input.Outcome != "rejected") ||
		(input.Reason != "" && !validReason(input.Reason)) {
		return StageSnapshot{}, false, fmt.Errorf("gate: неверная identity решения")
	}
	t, err := s.openTask(input.Task, true)
	if err != nil {
		return StageSnapshot{}, false, err
	}
	defer t.close()
	ledger, dir, err := t.loadStage(input.Task, input.Attempt, true)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return StageSnapshot{}, false, err
	}
	current := ledger.snapshot()
	last := ledger.events[len(ledger.events)-1].Data
	if input.ExpectedHead != "" && (current.Sequence != input.ExpectedSequence ||
		current.HeadEventHash != input.ExpectedHead) {
		if current.Sequence == input.ExpectedSequence+1 && last["previousEventHash"] == input.ExpectedHead &&
			last["kind"] == "commit" && last["node"] == input.Node && last["outcome"] == input.Outcome &&
			stringField(last, "reason") == input.Reason {
			return current, true, nil
		}
		return current, false, fmt.Errorf("%w: FACTORY_ERROR=stale_stage", ErrConflict)
	}
	if input.ExpectedHead == "" && current.CurrentNode != input.Node &&
		last["kind"] == "commit" && last["node"] == input.Node && last["outcome"] == input.Outcome &&
		stringField(last, "reason") == input.Reason {
		return current, true, nil
	}
	if current.State != "paused" || current.CurrentNode != input.Node {
		return current, false, fmt.Errorf("%w: gate не ожидает решения", ErrConflict)
	}
	input.ExpectedSequence, input.ExpectedHead = current.Sequence, current.HeadEventHash
	event, err := ledger.makeCommit(input)
	if err != nil {
		return current, false, err
	}
	next, err := ledger.append(dir, event, true, publishFile)
	return next, false, err
}

type RewindRequest struct {
	Task, Attempt, Node, Reason, Actor, ExpectedHead string
	ExpectedSequence                                 int64
}

// RewindStage фиксирует ручной возврат отдельным видом события.
// Закреплённая машина определяет порядок сбрасываемых узлов.
func (s Store) RewindStage(input RewindRequest) (StageSnapshot, error) {
	if !attemptPattern.MatchString(input.Attempt) || !stagePattern.MatchString(input.Node) ||
		!validReason(input.Reason) || (input.Actor != "" && !stagePattern.MatchString(input.Actor)) {
		return StageSnapshot{}, fmt.Errorf("goto: неверная identity возврата")
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
	if err := s.verifyRewindScope(ledger.bundle.Machine, input); err != nil {
		return StageSnapshot{}, err
	}
	current := ledger.snapshot()
	if input.ExpectedHead != "" &&
		(current.Sequence != input.ExpectedSequence || current.HeadEventHash != input.ExpectedHead) {
		return current, fmt.Errorf("%w: FACTORY_ERROR=stale_stage", ErrConflict)
	}
	reset, err := ledger.bundle.RewindReset(input.Node)
	if err != nil {
		return current, err
	}
	return appendHumanRewind(dir, ledger, current, input, reset)
}

func appendHumanRewind(
	dir *os.Root, ledger stageLedger, current StageSnapshot, input RewindRequest, reset []any,
) (StageSnapshot, error) {
	sequence := current.Sequence + 1
	before := objectField(ledger.pointer, "cursor")
	event := ledger.identity()
	maps.Copy(event, record{
		"sequence": wireNumber(sequence), "at": time.Now().UTC().Format(time.RFC3339),
		"kind": "human-rewind", "node": input.Node, "outcome": nil, "reason": input.Reason,
		"action": record{"rewind": input.Node, "reset": reset}, "previousEventHash": current.HeadEventHash,
		"before": before, "after": makeCursor("ready", input.Node, nil, nil, before["lastCommit"]),
	})
	if input.Actor != "" && input.Actor != "human" {
		event["actor"] = input.Actor
	}
	if err := ledger.validateEvent(event, before, current.HeadEventHash, sequence); err != nil {
		return current, err
	}
	return ledger.append(dir, event, true, publishFile)
}

// verifyRewindScope оставляет обработку активной инструментальной транзакции хосту.
// Прямой переход не снимает указатель и не меняет чужое рабочее дерево.
func (s Store) verifyRewindScope(machine map[string]any, input RewindRequest) error {
	nodes, _ := machine["nodes"].([]any)
	var instrument, proof, target = -1, -1, -1
	for i, raw := range nodes {
		node, _ := raw.(record)
		name := stringField(node, "id")
		if name == input.Node {
			target = i
		}
		switch name {
		case "instrument":
			instrument = i
		case "proof":
			proof = i
		}
	}
	if instrument < 0 || target <= instrument || target > proof {
		return nil
	}
	control, err := openControl(s.ControlDir, false)
	if err != nil {
		return err
	}
	defer control.Close()
	path := filepath.Join("transactions", "t"+input.Task, "active.env")
	data, err := readTrusted(control, path, 4096, ownerMode)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%w: goto %s требует активную инструментацию; верни курсор на instrument",
			ErrConflict, input.Node)
	}
	if err != nil {
		return err
	}
	fields, err := parseRunFields(data)
	if err != nil || !strings.HasPrefix(fields["TRANSACTION_ID"], "v2-"+input.Attempt[2:]+"-s") {
		return fmt.Errorf("%w: принадлежность активной инструментации не подтверждена", ErrConflict)
	}
	return nil
}
