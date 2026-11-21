package state

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
)

type seenLoop struct {
	transferred, workerResult, leadDecided bool
	previous, ids                          map[string]bool
}

// assignRewindPolicy добавляет budget stop или snapshot отдельного цикла.
// Управление счётчиками опирается только на immutable ledger текущей попытки.
func (l stageLedger) assignRewindPolicy(event record, input StageCommit) error {
	action := objectField(event, "action")
	target, isRewind := rewindTarget(action)
	pair := objectField(l.bundle.Machine, "loop")
	loopTransfer := isRewind && pair != nil && event["node"] == pair["lead"] && target == pair["worker"]
	if hasRecordField(input.Verdict, "stage") && !loopTransfer {
		return fmt.Errorf("stage: граница этапа вне передачи lead → worker")
	}
	if !isRewind {
		return nil
	}
	if loopTransfer {
		return l.assignLoopPolicy(event, pair, input)
	}
	if input.RewindLimit < 0 || input.RewindLimit > 10 ||
		input.NoProgressLimit < 0 || input.NoProgressLimit > 10 ||
		input.TargetBudget < 0 || input.TargetBudget > 10 {
		return fmt.Errorf("stage: неверные бюджеты повторов")
	}
	history, total := l.rewindHistory(input.Node, target)
	describe := input.Node + " → " + target
	if reason := l.progressStop(input, history, target); reason != "" {
		event["kind"], event["reason"] = "no-progress",
			"автоматический возврат остановлен без прогресса: "+describe+"; "+reason
	} else if input.RewindLimit > 0 && int64(len(history)) >= input.RewindLimit {
		event["kind"], event["reason"] = "rewind-limit", fmt.Sprintf(
			"автоматический лимит возвратов исчерпан: %s; уже выполнено %d", describe, input.RewindLimit)
	} else if input.TargetBudget > 0 && total >= input.TargetBudget {
		event["kind"], event["reason"] = "rewind-limit", fmt.Sprintf(
			"суммарный бюджет автоматических возвратов исчерпан за попытку: %s; уже выполнено %d",
			describe, input.TargetBudget)
	}
	return nil
}

func (l stageLedger) assignLoopPolicy(event, pair record, input StageCommit) error {
	if input.LoopMaxRounds < 1 || input.LoopMaxRounds > 300 {
		return fmt.Errorf("PROFILE_LOOP_MAX_ROUNDS: нужно целое 1..300")
	}
	seen := l.loopObservations(pair)
	accepted, rejection := seen.decide(input.Verdict)
	after := l.loopRounds + 1
	if l.loopRounds >= input.LoopMaxRounds {
		after = l.loopRounds
		event["kind"] = "loop-ceiling"
		event["reason"] = fmt.Sprintf("потолок кругов цикла исчерпан: %d из %d — "+
			"подними PROFILE_LOOP_MAX_ROUNDS в профиле и продолжи задачу", l.loopRounds, input.LoopMaxRounds)
	}
	stage := max(l.loopStage, 1)
	if accepted {
		stage = l.loopStage + 1
	}
	snapshot := record{
		"policy": wireNumber(1), "maxRounds": wireNumber(input.LoopMaxRounds),
		"roundsBefore": wireNumber(l.loopRounds), "roundsAfter": wireNumber(after),
		"stage": wireNumber(stage), "stageAccepted": accepted,
	}
	if rejection != "" {
		snapshot["stageRejected"] = rejection
	}
	event["loop"] = snapshot
	return nil
}

func (l stageLedger) loopObservations(pair record) seenLoop {
	seen := seenLoop{ids: make(map[string]bool)}
	for _, event := range l.events {
		row := event.Data
		kind := stringField(row, "kind")
		verdict := objectField(row, "verdict")
		if row["node"] == pair["lead"] && slices.Contains(
			[]string{"commit", "loop-continue", "loop-ceiling", "no-progress", "rewind-limit"}, kind) {
			ids := blockingFindings(verdict)
			maps.Copy(seen.ids, ids)
			target := objectField(row, "action")["rewind"]
			if (kind == "commit" || kind == "loop-continue") && target == pair["worker"] {
				seen.transferred, seen.workerResult, seen.leadDecided = true, false, false
				seen.previous = ids
				continue
			}
			seen.leadDecided = true
		}
		if row["node"] == pair["worker"] && kind == "commit" && row["outcome"] != "exhausted" {
			seen.workerResult, seen.leadDecided = true, false
		}
	}
	return seen
}

func (seen seenLoop) decide(verdict record) (bool, string) {
	stage := objectField(verdict, "stage")
	if stage == nil {
		return false, ""
	}
	switch {
	case !seen.transferred:
		return false, "no-transfer"
	case !seen.workerResult:
		return false, "no-worker-result"
	case seen.leadDecided:
		return false, "result-used"
	}
	closes := make(map[string]bool)
	for _, value := range arrayField(stage, "closes") {
		id, _ := value.(string)
		closes[id] = true
	}
	if !maps.Equal(closes, seen.previous) {
		return false, "closes-mismatch"
	}
	for id := range blockingFindings(verdict) {
		if seen.ids[id] {
			return false, "ids-reused"
		}
	}
	return true, ""
}

func blockingFindings(verdict record) map[string]bool {
	result := make(map[string]bool)
	for _, item := range arrayField(verdict, "findings") {
		finding, _ := item.(record)
		if finding["severity"] != "deferred" {
			result[stringField(finding, "id")] = true
		}
	}
	return result
}

func (l stageLedger) rewindHistory(node, target string) ([]record, int64) {
	var history []record
	var total int64
	for _, entry := range l.events {
		event := entry.Data
		rewind := objectField(event, "action")["rewind"]
		commit := event["kind"] == "commit"
		rejected := event["outcome"] == "rejected"
		same := event["node"] == node && rewind == target
		if commit && rewind == target && !rejected {
			total++
		}
		if event["kind"] == "human-rewind" || (commit && rejected && rewind != nil && !same) {
			history = history[:0]
		} else if commit && same {
			history = append(history, objectField(event, "verdict"))
		}
	}
	return history, total
}

// progressStop различает повтор, смену owner и расширение замкнутой серии.
// Отложенные замечания не расходуют бюджет блокирующих возвратов.
func (l stageLedger) progressStop(input StageCommit, history []record, target string) string {
	if input.NoProgressLimit == 0 || input.Verdict == nil {
		return ""
	}
	var typed []record
	for _, verdict := range history {
		if verdict != nil {
			typed = append(typed, verdict)
		}
	}
	if len(typed) == 0 {
		return ""
	}
	ids := blockingFindings(input.Verdict)
	owner := stringField(input.Verdict, "owner")
	prev := typed[len(typed)-1]
	if stringField(prev, "owner") == owner && maps.Equal(ids, blockingFindings(prev)) {
		return "повторяется тот же набор открытых замечаний после одного ремонта"
	}
	firstOwner := stringField(typed[0], "owner")
	if owner != firstOwner {
		return "замкнутый набор замечаний сменил владельца: " + firstOwner + " → " + owner
	}
	return expandedScope(input.Verdict, typed, "t"+l.attempt.Task+"."+target+".md")
}

func expandedScope(candidate record, history []record, document string) string {
	closed := blockingFindings(history[0])
	expanded := false
	reviewed := make(map[string]bool)
	for _, prior := range history {
		for _, item := range arrayField(prior, "reviewed") {
			if path, ok := item.(string); ok {
				reviewed[path] = true
			}
		}
		for id := range blockingFindings(prior) {
			if !closed[id] {
				expanded = true
			}
		}
	}
	if !expanded {
		return ""
	}
	var added []string
	for _, item := range arrayField(candidate, "findings") {
		finding, _ := item.(record)
		id, anchor := stringField(finding, "id"), stringField(finding, "anchor")
		if !closed[id] && finding["severity"] != "deferred" && anchor != document &&
			!(len(reviewed) > 0 && anchor != "" && !reviewed[anchor]) {
			added = append(added, id)
		}
	}
	if len(added) == 0 {
		return ""
	}
	slices.Sort(added)
	count := min(3, len(added))
	text := strings.Join(added[:count], ", ")
	if len(added) > count {
		text += fmt.Sprintf(" и ещё %d", len(added)-count)
	}
	return "замкнутый набор замечаний расширен новыми id: " + text
}

// ContinueLoop восстанавливает ровно ранее остановленную передачу после подъёма потолка.
// Последовательность и SHA связывают новое событие с прежним кандидатом.
func (s Store) ContinueLoop(
	task, id string, expected StageSnapshot, maxRounds int64,
) (StageSnapshot, int, error) {
	if !attemptPattern.MatchString(id) || maxRounds < 1 || maxRounds > 300 {
		return StageSnapshot{}, 78, fmt.Errorf("неверный max rounds или попытка")
	}
	t, err := s.openTask(task, true)
	if err != nil {
		return StageSnapshot{}, 78, err
	}
	defer t.close()
	ledger, dir, err := t.loadStage(task, id, true)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return StageSnapshot{}, 78, err
	}
	current := ledger.snapshot()
	prior := ledger.events[len(ledger.events)-1].Data
	if current != expected || prior["kind"] != "loop-ceiling" {
		ref := objectField(prior, "continues")
		if current.Sequence == expected.Sequence+1 && prior["kind"] == "loop-continue" &&
			ref["eventHash"] == expected.HeadEventHash {
			return current, 0, nil
		}
		return current, 75, ErrConflict
	}
	if maxRounds <= ledger.loopRounds {
		return current, 11, fmt.Errorf("потолок кругов не поднят")
	}
	node := stringField(prior, "node")
	sequence := current.Sequence + 1
	before := objectField(ledger.pointer, "cursor")
	target := objectField(prior, "action")["rewind"]
	loop := maps.Clone(objectField(prior, "loop"))
	loop["maxRounds"], loop["roundsAfter"] = wireNumber(maxRounds), wireNumber(ledger.loopRounds+1)
	event := ledger.identity()
	maps.Copy(event, record{
		"sequence": wireNumber(sequence), "at": time.Now().UTC().Format(time.RFC3339),
		"kind": "loop-continue", "node": node, "action": prior["action"], "outcome": prior["outcome"],
		"reason":            fmt.Sprintf("продолжение после поднятого потолка кругов: %d", maxRounds),
		"previousEventHash": current.HeadEventHash, "before": before,
		"after":     makeCursor("ready", target, nil, nil, before["lastCommit"]),
		"continues": record{"sequence": wireNumber(current.Sequence), "eventHash": current.HeadEventHash},
		"loop":      loop,
	})
	if prior["verdict"] != nil {
		event["verdict"] = prior["verdict"]
	}
	if err := ledger.validateEvent(event, before, current.HeadEventHash, sequence); err != nil {
		return current, 78, err
	}
	next, err := ledger.append(dir, event, true, publishFile)
	if err != nil {
		return current, 74, err
	}
	return next, 0, nil
}
