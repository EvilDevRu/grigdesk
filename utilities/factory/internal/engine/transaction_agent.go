package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/runner"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

type transactionView struct {
	id, scope string
	allowed   []transactionPath
}

// runTransactionAgent создаёт допуск перед каждой попыткой провайдера.
// Проигранный instrument восстанавливается до начала повтора с новым ID.
func (e execution) runTransactionAgent(
	ctx context.Context, cursor state.StageSnapshot, node map[string]any, key string,
) (state.StageSnapshot, int, error) {
	if runtime.GOOS != "linux" {
		return cursor, 75, fmt.Errorf("инструментация требует нативного подтверждения этой платформы")
	}
	request, err := e.runnerRequest(cursor, node, key, "")
	if err != nil {
		return cursor, 78, err
	}
	var tx *routeTransaction
	closeTransaction := func() {
		if tx != nil {
			if tx.scopeFile != "" {
				os.Remove(tx.scopeFile)
			}
			tx.journal.Close()
			tx = nil
		}
	}
	defer closeTransaction()
	request.BeforeInvoke = func(string) (string, error) {
		var err error
		tx, err = e.transaction(ctx, cursor, true)
		if err != nil {
			return "", err
		}
		if err := e.verifyActiveTransaction(ctx, tx); err != nil {
			return "", err
		}
		return e.transactionPrompt(cursor, key, tx)
	}
	request.AfterInvoke = func(result runner.DispatchResult) error {
		if result.RC == 75 {
			return fmt.Errorf("владение завершившимся деревом провайдера не подтверждено")
		}
		if err := e.checkpointTransaction(ctx, tx); err != nil {
			return err
		}
		if cursor.CurrentNode == "instrument" && result.Terminal.Result == "done" {
			return nil
		}
		err := e.finishTransaction(ctx, tx)
		closeTransaction()
		return err
	}
	visit, rc, err := e.beginAgentVisit(cursor, key)
	if err != nil {
		return cursor, rc, err
	}
	request.RecordRestart = e.restartLifecycle(visit)
	startedAt := time.Now()
	result, err := e.dispatchAgent(ctx, request)
	if canCloseSpeedRefusal(result, err) {
		failure := e.recordClosedAgent(visit, result, err, startedAt)
		return cursor, 75, errors.Join(err, failure)
	}
	if tx != nil && (errors.Is(err, context.Canceled) || (ctx.Err() != nil && result.RC == 130)) {
		if err := e.recoverStoppedTransaction(ctx, tx, cursor, result); err != nil {
			return cursor, 75, err
		}
	}
	if errors.Is(err, context.Canceled) {
		return cursor, 130, err
	}
	if err != nil {
		return cursor, 75, err
	}
	return e.commitAgent(ctx, cursor, key, result, visit)
}

// recoverStoppedTransaction восстанавливает scope после подтверждённой гибели процесса.
// Точный rewind меняет голову журнала, поэтому следующий визит открывает чистую транзакцию.
func (e execution) recoverStoppedTransaction(
	ctx context.Context, tx *routeTransaction, cursor state.StageSnapshot, result runner.DispatchResult,
) error {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 90*time.Second)
	defer cancel()
	confirmedStop := result.Run.Valid() && result.RC == 130
	if confirmedStop {
		if err := e.checkpointTransaction(cleanup, tx); err != nil {
			return err
		}
	}
	if err := e.finishTransaction(cleanup, tx); err != nil {
		return err
	}
	if !confirmedStop {
		return nil
	}
	target := cursor.CurrentNode
	if _, mode := e.bundle.LaunchTopology(); mode == "explicit" {
		target = "instrument"
	}
	return e.rewindStoppedInstrumentation(cursor, target)
}

// cleanupStoppedZone обрабатывает остановку между открытием транзакции и PROOF.
// После обычного узла допустим только прежний checkpoint, включая байты Git index.
func (e execution) cleanupStoppedZone(ctx context.Context, cursor state.StageSnapshot) error {
	if runtime.GOOS != "linux" || !e.inTransactionZone(cursor.CurrentNode) {
		return nil
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 90*time.Second)
	defer cancel()
	tx, err := e.transaction(cleanup, cursor, false)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer tx.journal.Close()
	if err := e.verifyActiveTransaction(cleanup, tx); err != nil {
		return err
	}
	if err := e.finishTransaction(cleanup, tx); err != nil {
		return err
	}
	return e.rewindStoppedInstrumentation(cursor, "instrument")
}

// inTransactionZone читает границы из закреплённой топологии.
// Узлы после PROOF не относятся к уже закрытой инструментации.
func (e execution) inTransactionZone(node string) bool {
	chain, err := e.bundle.RewindReset("instrument")
	if err != nil || e.findNode("proof") == nil {
		return false
	}
	for _, id := range chain {
		if id == node {
			return true
		}
		if id == "proof" {
			return false
		}
	}
	return false
}

func (e execution) rewindStoppedInstrumentation(cursor state.StageSnapshot, target string) error {
	req := DecisionRequest{
		LaunchRequest: e.request, Node: target, Actor: "engine", Output: io.Discard,
		ExpectedStage: fmt.Sprintf("%d:%s", cursor.Sequence, cursor.HeadEventHash),
		Reason:        "Временная инструментация восстановлена после подтверждённой остановки этапа",
	}
	req.Attempt = e.attempt.ID
	_, err := e.rewind(req)
	return err
}

// verifyActiveTransaction защищает следующий этап от дрейфа между запусками.
// Источник ожидаемого содержимого остаётся последним durable checkpoint.
func (e execution) verifyActiveTransaction(ctx context.Context, tx *routeTransaction) error {
	if tx.status.Phase != "active" {
		return fmt.Errorf("инструментация в состоянии %s", tx.status.Phase)
	}
	_, expected, err := tx.snapshots()
	if err != nil {
		return err
	}
	current, err := e.transactionSnapshot(ctx, tx.repos, tx.scope)
	if err != nil {
		return err
	}
	if !bytes.Equal(expected, current) {
		return tx.stall("concurrent_change", fmt.Errorf("workspace изменился между запусками"))
	}
	if err := tx.verifyExpectedIndexes(); err != nil {
		return tx.stall("concurrent_index_change", err)
	}
	return nil
}

// transactionPrompt передаёт агенту только readonly проекцию разрешённых путей.
// Долговечный каталог с восстановлением и резервными копиями остаётся у хоста.
func (e execution) transactionPrompt(
	cursor state.StageSnapshot, key string, tx *routeTransaction,
) (string, error) {
	file, err := os.CreateTemp(e.request.Store.StateDir, ".instrumentation-scope-")
	if err != nil {
		return "", err
	}
	tx.scopeFile = file.Name()
	_, err = file.WriteString(transactionScopeList(tx.scope))
	if err := errors.Join(err, file.Chmod(0400), file.Close()); err != nil {
		return "", err
	}
	e.instrumentation = transactionView{tx.id, file.Name(), tx.scope}
	return e.agentPrompt(cursor, key)
}

// resumeTransaction достраивает только уже начатую очистку.
// Active и stalled сохраняют прежние границы допуска визита.
func (e execution) resumeTransaction(ctx context.Context) error {
	_, mode := e.bundle.LaunchTopology()
	if mode == "disabled" || runtime.GOOS != "linux" {
		rc, err := e.checkNoActiveTransaction()
		if rc != 0 {
			return err
		}
		return nil
	}
	tx, err := e.transaction(ctx, state.StageSnapshot{}, false)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer tx.journal.Close()
	switch tx.status.Phase {
	case "active":
		return e.verifyActiveTransaction(ctx, tx)
	case "cleaning", "completed":
		return e.finishTransaction(ctx, tx)
	default:
		return fmt.Errorf("инструментация остановлена с причиной %s", tx.status.Reason)
	}
}
