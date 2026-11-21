package state

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// ReplayPending достраивает запись под task lock, не выполняя повторный effect.
// Отсутствующий tree возвращает needs-tree только при совпадении исходного cursor.
func (s Store) ReplayPending(task, attempt, tree string) (StageSnapshot, string, int, error) {
	return s.replayPending(task, attempt, tree, nil)
}

type transitionObserver func(string) error

func (s Store) replayPending(
	task, attempt, tree string, observe transitionObserver,
) (StageSnapshot, string, int, error) {
	if !attemptPattern.MatchString(attempt) {
		return StageSnapshot{}, "", 78, fmt.Errorf("intent: нужна точная попытка")
	}
	t, err := s.openTask(task, true)
	if err != nil {
		return StageSnapshot{}, "", 78, err
	}
	defer t.close()
	ledger, dir, loadErr := t.loadStage(task, attempt, true)
	if dir != nil {
		defer dir.Close()
	}
	if loadErr != nil && !errors.Is(loadErr, ErrStagePending) {
		return StageSnapshot{}, "", 78, loadErr
	}
	current := ledger.snapshot()
	name := filepath.Join("attempts", attempt, pendingFile)
	receipt, err := readPending(t.root, name, ledger.attempt)
	if errors.Is(err, os.ErrNotExist) && loadErr == nil {
		return current, "absent", 3, nil
	}
	if err != nil {
		return current, "", 78, err
	}
	if err := t.checkReceiptOrigin(ledger.attempt, receipt); err != nil {
		return current, "", 78, err
	}
	return t.driveReceipt(dir, name, ledger, receipt, tree, loadErr, observe)
}

func (t *taskState) driveReceipt(
	dir *os.Root, name string, ledger stageLedger, receipt PendingReceipt,
	tree string, loadErr error, observe transitionObserver,
) (StageSnapshot, string, int, error) {
	current := ledger.snapshot()
	last := ledger.events[len(ledger.events)-1]
	base, expectedTree, err := receipt.baseCursor()
	if err != nil {
		return current, "", 78, err
	}
	if loadErr != nil {
		return restoreReceiptPointer(dir, ledger, receipt, base, current, last, observe)
	}
	now := pendingCursor{
		sequence: current.Sequence, head: parseTrustedDigest(current.HeadEventHash),
		node: current.CurrentNode, state: current.State,
	}
	match, result, err := classifyPendingAtBase(base, now, expectedTree, nil)
	if err != nil {
		return current, "", 78, err
	}
	if match {
		if tree == "" {
			return current, result, 0, nil
		}
		treeHash, err := workspaceFingerprint(tree)
		if err != nil {
			return current, "", 74, err
		}
		if parseTrustedDigest(treeHash) == expectedTree {
			return appendReceipt(dir, ledger, receipt, current, observe)
		}
	} else if receiptMatch(receipt, current, last) {
		return current, "committed", 0, nil
	}
	baseHead := stringField(receipt.Base, "headEventHash")
	archive := filepath.Join(filepath.Dir(name), "pending-transition.stale."+baseHead+".json")
	if err := t.root.Rename(name, archive); err != nil {
		return current, "", 74, err
	}
	if err := syncDirectory(t.root, filepath.Dir(name)); err != nil {
		return current, "", 74, err
	}
	return current, "stale", 3, nil
}

func restoreReceiptPointer(
	dir *os.Root, ledger stageLedger, receipt PendingReceipt, base pendingCursor,
	current StageSnapshot, last StageEvent, observe transitionObserver,
) (StageSnapshot, string, int, error) {
	if current.Sequence != base.sequence || parseTrustedDigest(current.HeadEventHash) != base.head ||
		current.CurrentNode != base.node || current.State != "ready" {
		return current, "", 78, fmt.Errorf("intent: исходный cursor не подтверждён")
	}
	pointer := ledger.runtimeFrom(last)
	ledger.pointer = pointer
	recovered := ledger.snapshot()
	if !receiptMatch(receipt, recovered, last) {
		return current, "", 78, fmt.Errorf("intent: хвост журнала не доказан")
	}
	if err := writeRuntimePointer(dir, pointer, true); err != nil {
		return current, "", 74, err
	}
	if observe != nil {
		if err := observe("cursor-durable"); err != nil {
			return current, "", 74, err
		}
	}
	return recovered, "committed", 0, nil
}

func appendReceipt(
	dir *os.Root, ledger stageLedger, receipt PendingReceipt,
	current StageSnapshot, observe transitionObserver,
) (StageSnapshot, string, int, error) {
	result := receipt.Args[3]
	verdict, err := ParseRunVerdict(result, receipt.Args[5])
	if err != nil {
		return current, "", 78, err
	}
	owner := ""
	if result == "failed" {
		owner = stringField(verdict, "owner")
	}
	input := StageCommit{
		Task: ledger.attempt.Task, Attempt: ledger.attempt.ID, Node: current.CurrentNode,
		ExpectedSequence: current.Sequence, ExpectedHead: current.HeadEventHash, Outcome: result,
		FailureOwner: owner, Reason: receipt.Args[9], Verdict: verdict,
	}
	for index, target := range map[int]*int64{
		4: &input.RewindLimit, 6: &input.NoProgressLimit, 8: &input.TargetBudget, 10: &input.LoopMaxRounds,
	} {
		number, err := strconv.ParseInt(receipt.Args[index], 10, 64)
		if err != nil || number < 0 {
			return current, "", 78, fmt.Errorf("intent: неверный бюджет argv[%d]", index)
		}
		*target = number
	}
	event, err := ledger.makeCommit(input)
	if err != nil {
		return current, "", 78, err
	}
	next, err := ledger.append(dir, event, true, observePublication(observe))
	if err != nil {
		return current, "", 74, err
	}
	return next, "committed", 0, nil
}

func observePublication(observe transitionObserver) stagePublisher {
	if observe == nil {
		return publishFile
	}
	return func(root *os.Root, name string, data []byte, mode fsMode, replace bool) error {
		if err := publishFile(root, name, data, mode, replace); err != nil {
			return err
		}
		if strings.HasPrefix(name, "event.") {
			return observe("event-durable")
		}
		if name == "runtime.json" {
			return observe("cursor-durable")
		}
		return nil
	}
}

// AckPending удаляет exact receipt только после подтверждённого текущего event.
// Проекция и необходимая durable запись lifecycle должны быть уже выполнены вызывающим.
func (s Store) AckPending(task, attempt, eventHash string) error {
	if !attemptPattern.MatchString(attempt) || !digestPattern.MatchString(eventHash) {
		return fmt.Errorf("intent: нужна точная identity подтверждения")
	}
	t, err := s.openTask(task, true)
	if err != nil {
		return err
	}
	defer t.close()
	ledger, dir, err := t.loadStage(task, attempt, true)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return err
	}
	name := filepath.Join("attempts", attempt, pendingFile)
	receipt, err := readPending(t.root, name, ledger.attempt)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	current := ledger.snapshot()
	last := ledger.events[len(ledger.events)-1]
	if current.HeadEventHash != eventHash || !receiptMatch(receipt, current, last) {
		return fmt.Errorf("%w: подтверждение не принадлежит последнему событию", ErrConflict)
	}
	if err := t.root.Remove(name); err != nil {
		return err
	}
	return syncDirectory(t.root, filepath.Dir(name))
}

func (receipt PendingReceipt) baseCursor() (pendingCursor, [32]byte, error) {
	head := stringField(receipt.Base, "headEventHash")
	if !digestPattern.MatchString(head) || !digestPattern.MatchString(receipt.TreeHash) {
		return pendingCursor{}, [32]byte{}, fmt.Errorf("intent: неверный SHA")
	}
	cursor := pendingCursor{
		sequence: integerField(receipt.Base, "eventSequence"),
		head:     parseTrustedDigest(head), node: receipt.Args[2],
	}
	return cursor, parseTrustedDigest(receipt.TreeHash), nil
}

func parseTrustedDigest(value string) [32]byte {
	var digest [32]byte
	_, _ = hex.Decode(digest[:], []byte(value))
	return digest
}

// receiptMatch вычисляет witness из raw event под тем же validated ledger.
// Verdict сериализуется независимо с тем же закрытым каноническим кодеком.
func receiptMatch(receipt PendingReceipt, current StageSnapshot, event StageEvent) bool {
	value := event.Data
	want, err := ParseRunVerdict(receipt.Args[3], receipt.Args[5])
	if err != nil {
		return false
	}
	wanted := pendingBase{
		sequence:      integerField(receipt.Base, "eventSequence"),
		headEventHash: parseTrustedDigest(stringField(receipt.Base, "headEventHash")),
		node:          receipt.Args[2], outcome: receipt.Args[3], reason: receipt.Args[9],
	}
	if want != nil {
		raw, err := canonicalRunVerdict(want)
		if err != nil {
			return false
		}
		wanted.verdict = sha256.Sum256(raw)
	}
	state := pendingState{
		sequence: current.Sequence, headEventHash: parseTrustedDigest(current.HeadEventHash),
		state: current.State, currentNode: current.CurrentNode, stop: current.Stop,
	}
	actual := pendingEvent{
		kind: stringField(value, "kind"), node: stringField(value, "node"),
		outcome:           stringField(value, "outcome"),
		reason:            stringField(value, "reason"),
		previousEventHash: parseTrustedDigest(stringField(value, "previousEventHash")),
		rawHash:           sha256.Sum256(event.Raw),
	}
	if verdict := objectField(value, "verdict"); verdict != nil {
		raw, err := canonicalRunVerdict(verdict)
		if err != nil {
			return false
		}
		actual.verdict = sha256.Sum256(raw)
	}
	action := objectField(value, "action")
	if target, valid := rewindTarget(action); valid {
		actual.action = &stopAction{rewind: target}
	}
	return classifyPendingTail(wanted, state, actual) == "committed"
}

// checkReceiptOrigin открывает полный lifecycle ledger без повторного task flock.
// Пустой origin допустим только до появления lifecycle истории.
func (t *taskState) checkReceiptOrigin(attempt Attempt, receipt PendingReceipt) error {
	dir, err := t.openLifecycleFor(attempt, false, false)
	if errors.Is(err, os.ErrNotExist) && receipt.Origin == nil {
		return nil
	}
	if err != nil {
		return err
	}
	defer dir.close()
	ledger, err := loadLifecycle(dir.root, attempt)
	if err != nil || len(ledger.torn) != 0 {
		return fmt.Errorf("intent: lifecycle происхождение недоступно")
	}
	if receipt.Origin == nil {
		if len(ledger.events) == 0 {
			return nil
		}
		return fmt.Errorf("intent: отсутствует lifecycle origin")
	}
	witnesses := 0
	for _, entry := range ledger.events {
		row := entry.Data
		if row["kind"] != "node_visit_started" || row["nodeVisitId"] != receipt.Origin["nodeVisitId"] {
			continue
		}
		if !receiptOriginMatches(receipt.Origin, row) {
			return fmt.Errorf("intent: origin visit расходится с scope или ordinal")
		}
		witnesses++
	}
	if witnesses != 1 {
		return fmt.Errorf("intent: origin не подтверждён одним visit")
	}
	return nil
}

func receiptOriginMatches(origin, row record) bool {
	return row["orchestratorSessionId"] == origin["orchestratorSessionId"] &&
		row["nodeId"] == origin["node"] && row["runKey"] == origin["runKey"] &&
		objectField(row, "details")["cursorOrdinal"] == origin["cursorOrdinal"] &&
		slices.Contains([]string{"main", "tail", ""}, stringField(objectField(row, "details"), "phase"))
}
