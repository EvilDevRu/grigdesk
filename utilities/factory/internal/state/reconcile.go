package state

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"syscall"
)

const pendingFile = "pending-transition.json"

var pendingBindingFields = []string{"taskId", "attemptId", "profile", "catalogHash", "routeId", "routeHash"}

var (
	visitPattern   = regexp.MustCompile(`^nv_[a-f0-9]{32}$`)
	sessionPattern = regexp.MustCompile(`^os_[a-f0-9]{32}$`)
	runKeyPattern  = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
)

type PendingRequest struct {
	Task, Attempt, Tree, ExpectedHead string
	Sequence                          int64
	Args                              []string
	Origin                            map[string]any
}

type PendingReceipt struct {
	Base     map[string]any
	Args     []string
	TreeHash string
	Origin   map[string]any
}

// PreparePending фиксирует результат хостового узла до публикации перехода.
// Уже существующую квитанцию можно подтвердить только с теми же данными.
func (s Store) PreparePending(input PendingRequest) error {
	return s.preparePendingObserved(input, nil)
}

func (s Store) preparePendingObserved(input PendingRequest, observe transitionObserver) error {
	if !attemptPattern.MatchString(input.Attempt) {
		return fmt.Errorf("intent: нужна точная попытка")
	}
	hash, err := workspaceFingerprint(input.Tree)
	if err != nil {
		return err
	}
	t, err := s.openTask(input.Task, true)
	if err != nil {
		return err
	}
	defer t.close()
	ledger, dir, err := t.loadStage(input.Task, input.Attempt, true)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return err
	}
	info := ledger.snapshot()
	if info.State != "ready" || info.Sequence != input.Sequence || info.HeadEventHash != input.ExpectedHead {
		return fmt.Errorf("%w: intent cursor изменился", ErrConflict)
	}
	if err := t.writePending(ledger.attempt, input, hash, info); err != nil {
		return err
	}
	if observe != nil {
		return observe("receipt-durable")
	}
	return nil
}

// writePending сравнивает обе записи по одной закрытой схеме.
// Receipt находится в trusted attempt, отдельно от дерева проекта.
func (t *taskState) writePending(
	attempt Attempt, input PendingRequest, hash string, stage StageSnapshot,
) error {
	base := pendingBaseRecord(attempt, stage)
	value := record{
		"schema": json.Number("1"), "args": input.Args, "treeHash": hash, "origin": nil, "base": base,
	}
	if input.Origin != nil {
		value["origin"] = input.Origin
	}
	// Нормализуем внутренний вызов к тем же JSON-типам, что у записи предыдущего writer.
	raw, err := compactRecord(value)
	if err != nil {
		return err
	}
	reloaded, err := decodeRecord(raw)
	if err != nil {
		return err
	}
	receipt, err := decodeReceipt(reloaded, attempt)
	if err != nil {
		return err
	}
	name := filepath.Join("attempts", attempt.ID, pendingFile)
	existing, err := readPending(t.root, name, attempt)
	if errors.Is(err, os.ErrNotExist) {
		return publishFile(t.root, name, raw, immutableMode, false)
	}
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(receipt, existing) {
		return fmt.Errorf("%w: другой intent уже существует", ErrConflict)
	}
	return nil
}

func pendingBaseRecord(attempt Attempt, stage StageSnapshot) record {
	return record{
		"taskId": attempt.Task, "attemptId": attempt.ID, "profile": attempt.Profile,
		"catalogHash": attempt.CatalogHash, "routeId": attempt.RouteID, "routeHash": attempt.RouteHash,
		"eventSequence": wireNumber(stage.Sequence), "headEventHash": stage.HeadEventHash,
		"currentNode": stage.CurrentNode,
	}
}

// readPending принимает только обычный readonly-файл точной попытки.
// Значения не используются как shell-скрипт или как другая файловая identity.
func readPending(root *os.Root, name string, attempt Attempt) (PendingReceipt, error) {
	raw, err := readTrusted(root, name, metadataBytes, immutableMode)
	if err != nil {
		return PendingReceipt{}, err
	}
	value, err := decodeRecord(raw)
	if err != nil {
		return PendingReceipt{}, err
	}
	return decodeReceipt(value, attempt)
}

// decodeReceipt проверяет сохранённые 11 аргументов ABI и базовый CAS.
// Origin относится к конкретной сессии и визиту того же cursorOrdinal.
func decodeReceipt(value record, attempt Attempt) (PendingReceipt, error) {
	var receipt PendingReceipt
	if !exactFields(value, "schema", "base", "args", "treeHash", "origin") ||
		value["schema"] != json.Number("1") {
		return receipt, fmt.Errorf("intent: неверная схема")
	}
	base := objectField(value, "base")
	fields := append(slices.Clone(pendingBindingFields), "eventSequence", "headEventHash", "currentNode")
	if !exactFields(base, fields...) {
		return receipt, fmt.Errorf("intent: неверная форма base")
	}
	expected := pendingBaseRecord(attempt, StageSnapshot{})
	for _, field := range pendingBindingFields {
		if base[field] != expected[field] {
			return receipt, fmt.Errorf("intent: identity попытки изменилась")
		}
	}
	args := arrayField(value, "args")
	if len(args) != 11 {
		return receipt, fmt.Errorf("intent: нужны ровно 11 аргументов")
	}
	receipt.Args = make([]string, len(args))
	for index, item := range args {
		text, ok := item.(string)
		if !ok || strings.ContainsRune(text, 0) {
			return PendingReceipt{}, fmt.Errorf("intent: неверный argv[%d]", index)
		}
		receipt.Args[index] = text
	}
	node, outcome := receipt.Args[2], receipt.Args[3]
	outcomes := []string{"done", "failed", "skipped", "exhausted"}
	sequence, _ := base["eventSequence"].(json.Number)
	ordinal, numberErr := sequence.Int64()
	receipt.Base, receipt.TreeHash = base, stringField(value, "treeHash")
	if args[0] != attempt.Task || args[1] != attempt.ID || base["currentNode"] != node ||
		!stagePattern.MatchString(node) || !slices.Contains(outcomes, outcome) ||
		numberErr != nil || ordinal < 0 || !digestPattern.MatchString(receipt.TreeHash) ||
		!digestPattern.MatchString(stringField(base, "headEventHash")) {
		return PendingReceipt{}, fmt.Errorf("intent: неверный base cursor")
	}
	if origin := value["origin"]; origin != nil {
		receipt.Origin, _ = origin.(record)
		if !validReceiptOrigin(receipt.Origin, node, sequence) {
			return PendingReceipt{}, fmt.Errorf("intent: origin не совпадает с визитом")
		}
	}
	return receipt, nil
}

func validReceiptOrigin(origin record, node string, sequence json.Number) bool {
	fields := []string{"nodeVisitId", "orchestratorSessionId", "node", "runKey", "cursorOrdinal"}
	key := stringField(origin, "runKey")
	return exactFields(origin, fields...) && visitPattern.MatchString(stringField(origin, "nodeVisitId")) &&
		sessionPattern.MatchString(stringField(origin, "orchestratorSessionId")) &&
		origin["node"] == node && runKeyPattern.MatchString(key) && strings.ToLower(key) == node &&
		origin["cursorOrdinal"] == sequence
}

// ReconcilePendingStage переставляет указатель только после подтверждения exact commit.
// Решение не выполняет заново команду, генерацию или внешнее действие.
func (s Store) ReconcilePendingStage(task, attempt string) (StageSnapshot, error) {
	if !attemptPattern.MatchString(attempt) {
		return StageSnapshot{}, fmt.Errorf("intent: нужна точная попытка")
	}
	t, err := s.openTask(task, true)
	if err != nil {
		return StageSnapshot{}, err
	}
	defer t.close()
	ledger, dir, err := t.loadStage(task, attempt, true)
	if dir != nil {
		defer dir.Close()
	}
	if err == nil {
		return ledger.snapshot(), nil
	}
	if !errors.Is(err, ErrStagePending) {
		return StageSnapshot{}, err
	}
	name := filepath.Join("attempts", attempt, pendingFile)
	receipt, err := readPending(t.root, name, ledger.attempt)
	if err != nil {
		return StageSnapshot{}, err
	}
	before := ledger.snapshot()
	expectedBase := pendingBaseRecord(ledger.attempt, before)
	if before.State != "ready" || !reflect.DeepEqual(receipt.Base, expectedBase) {
		return StageSnapshot{}, fmt.Errorf("intent: квитанция относится к другому cursor")
	}
	last := ledger.events[len(ledger.events)-1]
	if !receipt.matchesCommit(last) {
		return StageSnapshot{}, fmt.Errorf("intent: неопубликованный хвост не доказан")
	}
	recovered := ledger.runtimeFrom(last)
	if err := writeRuntimePointer(dir, recovered, true); err != nil {
		return StageSnapshot{}, err
	}
	ledger.pointer = recovered
	return ledger.snapshot(), nil
}

// matchesCommit связывает результат квитанции с raw bytes уже принятого события.
// Для budget stop причина создаётся writer, для commit должна совпасть точно.
func (r PendingReceipt) matchesCommit(event StageEvent) bool {
	value := event.Data
	kind := stringField(value, "kind")
	kinds := []string{"commit", "no-progress", "rewind-limit", "loop-ceiling"}
	if !slices.Contains(kinds, kind) || value["node"] != r.Args[2] || value["outcome"] != r.Args[3] ||
		value["previousEventHash"] != r.Base["headEventHash"] || digestOf(event.Raw) != event.Hash ||
		integerField(value, "sequence") != integerField(r.Base, "eventSequence")+1 {
		return false
	}
	var verdict any
	if r.Args[5] != "" {
		bytes, err := base64.StdEncoding.Strict().DecodeString(r.Args[5])
		if err != nil {
			return false
		}
		decode, err := decodeRecord(bytes)
		if err != nil {
			return false
		}
		verdict = decode
	}
	if !reflect.DeepEqual(verdict, value["verdict"]) {
		return false
	}
	if kind == "commit" {
		if r.Args[9] == "" {
			return value["reason"] == nil
		}
		return value["reason"] == r.Args[9]
	}
	after := objectField(value, "after")
	return after["state"] == "stopped" && after["stop"] == kind && validReason(stringField(value, "reason"))
}

// workspaceFingerprint хеширует уже подготовленный guard-снимок.
// Список файлов и volatile исключений принадлежит снимку, а не этой операции.
func workspaceFingerprint(path string) (string, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return "", fmt.Errorf("intent: нужен абсолютный путь снимка")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("intent: снимок должен быть обычным файлом")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
