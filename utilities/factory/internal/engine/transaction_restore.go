package engine

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/hooks"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

type transactionBackup struct {
	path, mode, hash string
	data             []byte
}

// captureBackups создаёт прежние files.tsv, indexes.tsv и содержимое исходных файлов.
// Имена копий выводятся из физических путей, выбранных доверенным профилем.
func (tx *routeTransaction) captureBackups() (map[string][]byte, error) {
	result := make(map[string][]byte)
	var files, indexes, fingerprints strings.Builder
	for _, path := range tx.scope {
		abs := path.absolute()
		obj, err := readTransactionObject(abs)
		if err != nil {
			return nil, fmt.Errorf("unsafe_scope_object: %w", err)
		}
		kind, file := "missing", "-"
		if obj.info != nil {
			kind, file = "file", "backups/"+txnDigest([]byte(abs))+".data"
			result[file] = obj.data
		}
		mode, hash := obj.fields()
		fmt.Fprintf(&files, "%s\t%s\t%s\t%s\t%s\t%s\t-\t%s\n",
			txnB64(abs), txnB64(path.repo), txnB64(path.relative), kind, mode, hash, file)
	}
	for _, repo := range tx.repos {
		obj, err := readTransactionObject(repo.index)
		if err != nil {
			return nil, err
		}
		flag, file := "0", "-"
		if obj.info != nil {
			flag, file = "1", "indexes/"+txnDigest([]byte(repo.path))+".index"
			result[file] = obj.data
		}
		mode, hash := obj.fields()
		fmt.Fprintf(&indexes, "%s\t%s\t%s\t%s\t%s\t%s\n", txnB64(repo.path),
			repo.index, flag, mode, hash, file)
		fmt.Fprintf(&fingerprints, "%s\t%s\n", mode, hash)
	}
	result["files.tsv"], result["indexes.tsv"] = []byte(files.String()), []byte(indexes.String())
	result["baseline.indexes"] = []byte(fingerprints.String())
	return result, nil
}

// indexFingerprints защищает физическое содержимое индексов в дополнение к Git diff.
// Старые Linux-снимки без такой ведомости продолжают сверяться по TSV.
func (tx *routeTransaction) indexFingerprints() ([]byte, error) {
	var out strings.Builder
	for _, repo := range tx.repos {
		index, err := readTransactionObject(repo.index)
		if err != nil {
			return nil, err
		}
		mode, hash := index.fields()
		fmt.Fprintf(&out, "%s\t%s\n", mode, hash)
	}
	return []byte(out.String()), nil
}

type transactionRowKey struct {
	kind, root, relative string
}

// transactionRows индексирует записи по типу и пути.
// Aggregate diff пропускается только при проверке scope и прерванной очистки.
func transactionRows(raw []byte) (map[transactionRowKey]string, error) {
	result := make(map[transactionRowKey]string)
	for row := range strings.SplitSeq(strings.TrimSuffix(string(raw), "\n"), "\n") {
		fields := strings.Split(row, "\t")
		key := transactionRowKey{kind: fields[0]}
		switch {
		case row == "SCHEMA\t1":
		case len(fields) == 2 && key.kind == "ROOT", len(fields) == 3 && key.kind == "HEAD":
			key.root = fields[1]
		case len(fields) == 3 && (key.kind == "WORKTREE_DIFF" || key.kind == "INDEX_DIFF"):
			continue
		case len(fields) == 4 && (key.kind == "TRACKED_WORKTREE" || key.kind == "TRACKED_INDEX"),
			len(fields) == 7 && (key.kind == "UNTRACKED" || key.kind == "SENSITIVE"):
			key.root, key.relative = fields[1], fields[2]
		default:
			return nil, fmt.Errorf("неизвестная строка workspace guard")
		}
		if _, found := result[key]; found {
			return nil, fmt.Errorf("повтор строки workspace guard")
		}
		result[key] = row
	}
	if result[transactionRowKey{kind: "SCHEMA"}] == "" {
		return nil, fmt.Errorf("отсутствует схема workspace guard")
	}
	return result, nil
}

// compareTransactionScope доказывает неизменность каждой записи вне разрешённых путей.
// HEAD и список репозиториев всегда остаются частью проверки.
func compareTransactionScope(before, after []byte, scope []transactionPath) error {
	old, err := transactionRows(before)
	if err != nil {
		return err
	}
	current, err := transactionRows(after)
	if err != nil {
		return err
	}
	for _, path := range scope {
		for _, kind := range []string{"TRACKED_WORKTREE", "TRACKED_INDEX", "UNTRACKED", "SENSITIVE"} {
			key := transactionRowKey{kind, txnB64(path.repo), txnB64(path.relative)}
			delete(old, key)
			delete(current, key)
		}
	}
	if !equivalentTransactionRows(current, old, old) {
		return fmt.Errorf("изменение вне объявленного scope")
	}
	return nil
}

// equivalentTransactionRows проверяет присутствие и значение каждой записи.
// При interrupted cleanup объект может быть только на baseline или на expected.
func equivalentTransactionRows(current, baseline, expected map[transactionRowKey]string) bool {
	for _, group := range []map[transactionRowKey]string{current, baseline, expected} {
		for key := range group {
			if current[key] != baseline[key] && current[key] != expected[key] {
				return false
			}
		}
	}
	return true
}

// loadBackups сверяет все записи и копии до первой операции над рабочим деревом.
// Записи из control не могут назначить произвольный путь для restore.
func (tx *routeTransaction) loadBackups() ([]transactionBackup, error) {
	files, err := tx.journal.Read(tx.id, "files.tsv")
	if err != nil {
		return nil, err
	}
	indexes, err := tx.journal.Read(tx.id, "indexes.tsv")
	if err != nil {
		return nil, err
	}
	fileRows := strings.Split(strings.TrimSuffix(string(files), "\n"), "\n")
	indexRows := strings.Split(strings.TrimSuffix(string(indexes), "\n"), "\n")
	if len(fileRows) != len(tx.scope) || len(indexRows) != len(tx.repos) {
		return nil, fmt.Errorf("размер ведомости backup не соответствует scope и repos")
	}
	var result []transactionBackup
	for i, path := range tx.scope {
		fields := strings.Split(fileRows[i], "\t")
		absolute := path.absolute()
		if len(fields) != 8 || fields[0] != txnB64(absolute) || fields[1] != txnB64(path.repo) ||
			fields[2] != txnB64(path.relative) || fields[6] != "-" {
			return nil, fmt.Errorf("повреждена строка files.tsv")
		}
		item, err := tx.loadBackup(fields[3], fields[4:6], fields[7], absolute,
			"backups/"+txnDigest([]byte(absolute))+".data")
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	for i, repo := range tx.repos {
		fields := strings.Split(indexRows[i], "\t")
		if len(fields) != 6 || fields[0] != txnB64(repo.path) || filepath.Clean(fields[1]) != repo.index {
			return nil, fmt.Errorf("повреждена строка indexes.tsv")
		}
		kind := map[string]string{"0": "missing", "1": "file"}[fields[2]]
		item, err := tx.loadBackup(kind, fields[3:5], fields[5], repo.index,
			"indexes/"+txnDigest([]byte(repo.path))+".index")
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}

// loadBackup проверяет размер, хэш и режим до выдачи исходного объекта.
// Пропавший файл описывается единственным набором допустимых полей.
func (tx *routeTransaction) loadBackup(
	kind string, metadata []string, file, path, expected string,
) (transactionBackup, error) {
	item := transactionBackup{path: path, mode: metadata[0], hash: metadata[1]}
	if kind == "missing" && file == "-" && item.mode == "-" && item.hash == "-" {
		return item, nil
	}
	mode, err := strconv.ParseUint(item.mode, 8, 9)
	if kind != "file" || file != expected || err != nil || strconv.FormatUint(mode, 8) != item.mode {
		return item, fmt.Errorf("недопустимая копия инструментации")
	}
	item.data, err = tx.journal.Read(tx.id, file)
	if err != nil || txnDigest(item.data) != item.hash {
		return item, fmt.Errorf("backup не соответствует принятому хэшу: %v", err)
	}
	return item, nil
}

// finishTransaction восстанавливает исходные объекты лишь после сравнения всего дерева.
// Стадия cleaning сохраняется до первой записи и допускает продолжение после сбоя.
func (e execution) finishTransaction(ctx context.Context, tx *routeTransaction) error {
	if tx.status.Phase != "active" && tx.status.Phase != "cleaning" && tx.status.Phase != "completed" {
		return fmt.Errorf("транзакция инструментации в состоянии %s", tx.status.Phase)
	}
	baseline, expected, err := tx.snapshots()
	if err != nil {
		return err
	}
	current, err := e.transactionSnapshot(ctx, tx.repos, tx.scope)
	if err != nil {
		return tx.stall("cleanup_snapshot_failed", err)
	}
	if tx.status.Phase != "completed" {
		if err := tx.checkCleanupSnapshot(baseline, expected, current); err != nil {
			return err
		}
		if err := e.restoreTransactionObjects(tx, baseline, current); err != nil {
			return err
		}
		current, err = e.transactionSnapshot(ctx, tx.repos, tx.scope)
	}
	if err != nil || !bytes.Equal(baseline, current) {
		return tx.stall("baseline_not_restored", fmt.Errorf("workspace сместился: %v", err))
	}
	if err := e.checkTransactionMarker(ctx, tx); err != nil {
		return tx.stall("baseline_not_restored", err)
	}
	if err := tx.journal.Write(tx.id, "cleanup-final.tsv", current, true); err != nil {
		return err
	}
	if err := e.syncTransactionStand(ctx, tx); err != nil {
		return tx.stall("restore_hook_failed", err)
	}
	afterHook, err := e.transactionSnapshot(ctx, tx.repos, tx.scope)
	if err != nil || !bytes.Equal(baseline, afterHook) {
		return tx.stall("baseline_not_restored", fmt.Errorf("workspace изменился после восстановления стенда"))
	}
	if err := tx.verifyRestoredIndexes(); err != nil {
		return tx.stall("baseline_not_restored", err)
	}
	tx.status.Phase = "completed"
	if err := tx.journal.SetStatus(tx.id, tx.status); err != nil {
		return err
	}
	return tx.journal.Clear(tx.id)
}

// verifyRestoredIndexes сверяет байты до снятия указателя на транзакцию.
// Снимка Git diff недостаточно: refresh меняет содержимое индекса без изменения diff.
func (tx *routeTransaction) verifyRestoredIndexes() error {
	indexes, err := tx.loadBackups()
	if err != nil {
		return err
	}
	for _, saved := range indexes[len(tx.scope):] {
		obj, err := readTransactionObject(saved.path)
		if err != nil {
			return err
		}
		mode, hash := obj.fields()
		if mode != saved.mode || hash != saved.hash {
			return fmt.Errorf("точный исходный Git index не восстановлен")
		}
	}
	return nil
}

// checkCleanupSnapshot допускает только точный expected либо доказанное частичное restore.
// При конфликте запись stalled предшествует возврату ошибки человеку.
func (tx *routeTransaction) checkCleanupSnapshot(baseline, expected, current []byte) error {
	if tx.status.Phase == "active" {
		if !bytes.Equal(current, expected) {
			return tx.stall("concurrent_change", fmt.Errorf("workspace изменился после checkpoint"))
		}
		return nil
	}
	a, first := transactionRows(baseline)
	b, second := transactionRows(expected)
	c, third := transactionRows(current)
	if first != nil || second != nil || third != nil || !equivalentTransactionRows(c, a, b) {
		return tx.stall("cleanup_resume_conflict", fmt.Errorf("workspace содержит чужое изменение"))
	}
	return nil
}

// restoreTransactionObjects сверяет ведомость с baseline и открывает каждую цель повторно.
// Durable cleaning не отменяется при ошибке I/O, поэтому следующий вызов проверит смесь состояний.
func (e execution) restoreTransactionObjects(tx *routeTransaction, baseline, current []byte) error {
	items, err := tx.loadBackups()
	if err != nil {
		return err
	}
	original, err := transactionRows(baseline)
	if err != nil {
		return err
	}
	observed, err := transactionRows(current)
	if err != nil {
		return err
	}
	expected := make([]transactionBackup, len(items))
	for i, path := range tx.scope {
		key := transactionRowKey{"SENSITIVE", txnB64(path.repo), txnB64(path.relative)}
		mode, hash := snapshotObjectFields(original[key])
		if mode != items[i].mode || hash != items[i].hash {
			return fmt.Errorf("backup расходится с baseline")
		}
		mode, hash = snapshotObjectFields(observed[key])
		expected[i] = transactionBackup{mode: mode, hash: hash}
	}
	if err := tx.prepareIndexRestore(items[len(tx.scope):], expected[len(tx.scope):]); err != nil {
		return tx.stall("concurrent_index_change", err)
	}
	if err := tx.journal.Write(tx.id, "cleanup-current.tsv", current, true); err != nil {
		return err
	}
	tx.status.Phase = "cleaning"
	if err := tx.journal.SetStatus(tx.id, tx.status); err != nil {
		return err
	}
	for i, item := range items {
		if err := restoreTransactionObject(item, expected[i]); err != nil {
			return fmt.Errorf("restore остановлен: %w", err)
		}
		e.transactionRestoreFault(i + 1)
	}
	return nil
}

// prepareIndexRestore сопоставляет физические индексы с durable checkpoint.
// Прерванная очистка допускает отдельные индексы, уже возвращённые к baseline.
func (tx *routeTransaction) prepareIndexRestore(items, expected []transactionBackup) error {
	rows, err := tx.expectedIndexRows()
	if err != nil {
		return err
	}
	for i := range items {
		obj, err := readTransactionObject(items[i].path)
		if err != nil {
			return err
		}
		expected[i].mode, expected[i].hash = obj.fields()
		current := expected[i].mode + "\t" + expected[i].hash
		restored := tx.status.Phase == "cleaning" && current == items[i].mode+"\t"+items[i].hash
		if rows != nil && current != rows[i] && !restored {
			return fmt.Errorf("физический индекс изменился после checkpoint")
		}
	}
	return nil
}

func (tx *routeTransaction) expectedIndexRows() ([]string, error) {
	proof := "baseline.indexes"
	if tx.status.Checkpoint > 0 {
		proof = checkpointFile(tx.status.Checkpoint) + ".indexes"
	}
	raw, err := tx.journal.Read(tx.id, proof)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rows := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	if len(rows) != len(tx.repos) {
		return nil, fmt.Errorf("повреждена ведомость ожидаемых индексов")
	}
	return rows, nil
}

// verifyExpectedIndexes дополняет Git diff проверкой физических байтов.
// Исторический Linux-журнал может содержать только семантический снимок.
func (tx *routeTransaction) verifyExpectedIndexes() error {
	rows, err := tx.expectedIndexRows()
	if err != nil || rows == nil {
		return err
	}
	current, err := tx.indexFingerprints()
	if err != nil {
		return err
	}
	if string(current) != strings.Join(rows, "\n")+"\n" {
		return fmt.Errorf("физический индекс изменился после checkpoint")
	}
	return nil
}

func snapshotObjectFields(row string) (string, string) {
	if row == "" {
		return "-", "-"
	}
	fields := strings.Split(row, "\t")
	return fields[4], fields[5]
}

// restoreTransactionObject атомарно возвращает один файл по подтверждённому снимку.
// Операция с объектом, который уже на baseline, ничего не перезаписывает.
func restoreTransactionObject(baseline, expected transactionBackup) error {
	dir := filepath.Dir(baseline.path)
	if !physicalTransactionDir(dir) {
		return fmt.Errorf("родитель restore изменился")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	name := filepath.Base(baseline.path)
	obj, err := readTransactionAt(root, name)
	if err != nil {
		return err
	}
	mode, hash := obj.fields()
	if mode == baseline.mode && hash == baseline.hash {
		return nil
	}
	if mode != expected.mode || hash != expected.hash {
		return fmt.Errorf("restore CAS: объект изменился")
	}
	if baseline.mode == "-" {
		current, err := root.Lstat(name)
		if err != nil || !sameTransactionFile(obj.info, current) {
			return fmt.Errorf("restore CAS: имя изменилось")
		}
		if err := root.Remove(name); err != nil {
			return err
		}
	} else if err := replaceTransactionObject(root, name, baseline, obj.info); err != nil {
		return err
	}
	parent, err := root.Open(".")
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

// replaceTransactionObject публикует содержимое одним rename после fsync.
// Перед сменой имени ещё раз сверяется исходный inode или его отсутствие.
func replaceTransactionObject(root *os.Root, name string, backup transactionBackup, prior os.FileInfo) error {
	tmp := ".instrumentation-restore-" + rand.Text()
	file, err := host.OpenAt(root, tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600, 0)
	if err != nil {
		return err
	}
	defer root.Remove(tmp)
	defer file.Close()
	if _, err := file.Write(backup.data); err != nil {
		return err
	}
	mode, _ := strconv.ParseUint(backup.mode, 8, 9)
	if err := file.Chmod(os.FileMode(mode)); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	current, err := root.Lstat(name)
	appeared := prior == nil && !os.IsNotExist(err)
	changed := prior != nil && (err != nil || !sameTransactionFile(prior, current))
	if appeared || changed {
		return fmt.Errorf("restore CAS: имя изменилось")
	}
	return root.Rename(tmp, name)
}

// transactionRestoreFault повторяет штатный тестовый барьер исторической реализации.
// Он доступен только для изолированного worker с включённым FACTORY_TESTING.
func (e execution) transactionRestoreFault(restored int) {
	env := e.request.Environment
	limit := environmentValue(env, "FACTORY_INSTRUMENTATION_TEST_CRASH_AFTER_RESTORE_OBJECTS")
	if environmentValue(env, "FACTORY_TESTING") == "1" && limit == strconv.Itoa(restored) {
		os.Exit(137)
	}
}

// syncTransactionStand сохраняет прежний профильный ABI для shared Linux-стенда.
// Hook получает только расположение восстановленного scope и точный номер задачи.
func (e execution) syncTransactionStand(ctx context.Context, tx *routeTransaction) error {
	if e.workspace.Mode != "shared" || tx.status.Phase == "completed" {
		return nil
	}
	file, err := os.CreateTemp(e.request.Store.StateDir, ".instrumentation-scope-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.WriteString(transactionScopeList(tx.scope))
	if err := errors.Join(err, file.Chmod(0400), file.Close()); err != nil {
		return fmt.Errorf("не удалось передать scope для синхронизации: %w", err)
	}
	return hooks.InstrumentationRestored(ctx, e.invoke, e.attempt.Task, file.Name())
}
