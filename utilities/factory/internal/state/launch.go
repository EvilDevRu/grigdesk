package state

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

// LockOrchestrator занимает исторический per-task lock отдельно от хранилища.
// Короткие читатели stage могут работать, пока выполняется долгий узел.
func (s Store) LockOrchestrator(task string) (*os.File, int, error) {
	if !taskPattern.MatchString(task) || rootsOverlap(s.ControlDir, s.StateDir) {
		return nil, 78, fmt.Errorf("неверный task или пересекающиеся корни")
	}
	root, err := openControl(s.ControlDir, true)
	if err != nil {
		return nil, 78, err
	}
	defer root.Close()
	for _, dir := range []string{"protocol-v2", "protocol-v2/orchestrators"} {
		if err := ensurePrivateDirectory(root, dir, true); err != nil {
			return nil, 78, err
		}
	}
	lock, err := openNamedLock(root, "protocol-v2/orchestrators/t"+task+".lock")
	if err != nil {
		return nil, 78, err
	}
	if err := host.TryProcessLock(lock); err != nil {
		lock.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, 73, fmt.Errorf("оркестратор задачи уже запущен")
		}
		return nil, 78, err
	}
	return lock, 0, nil
}

func openNamedLock(root *os.Root, name string) (*os.File, error) {
	flags := os.O_RDWR | os.O_CREATE | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	lock, err := root.OpenFile(name, flags, 0600)
	if err != nil {
		return nil, err
	}
	info, err := lock.Stat()
	if err == nil && info.Mode().IsRegular() && ownedByInvoker(info) {
		if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Nlink == 1 {
			return lock, nil
		}
	}
	lock.Close()
	return nil, fmt.Errorf("недопустимый файл lock")
}

// AttemptArtifact возвращает проверенные байты и путь immutable артефакта.
// Запись может создать отсутствующий файл или подтвердить точное совпадение.
func (s Store) AttemptArtifact(
	attempt Attempt, name string, expected []byte, create bool,
) ([]byte, string, error) {
	if !attemptPattern.MatchString(attempt.ID) || filepath.Base(name) != name ||
		name == "." || name == ".." || !stageArtifact(name) {
		return nil, "", fmt.Errorf("неверный артефакт попытки")
	}
	task, err := s.openTask(attempt.Task, create)
	if err != nil {
		return nil, "", err
	}
	defer task.close()
	if create {
		id, err := task.activeAttempt(attempt.Task)
		if err != nil || id != attempt.ID {
			return nil, "", fmt.Errorf("%w: попытка для артефакта сменилась", ErrConflict)
		}
	}
	dir := filepath.Join("attempts", attempt.ID, "artifacts")
	if err := ensurePrivateDirectory(task.root, dir, create); err != nil {
		return nil, "", err
	}
	name = filepath.Join(dir, name)
	if len(expected) > metadataBytes {
		return nil, "", fmt.Errorf("артефакт превышает лимит")
	}
	raw, err := readTrusted(task.root, name, metadataBytes, immutableMode)
	if create && errors.Is(err, os.ErrNotExist) {
		err = publishFile(task.root, name, expected, immutableMode, false)
		raw = expected
	}
	if err != nil {
		return nil, "", err
	}
	if expected != nil && !bytes.Equal(raw, expected) {
		return nil, "", fmt.Errorf("%w: закреплённый %s изменился", ErrConflict, filepath.Base(name))
	}
	path := filepath.Join(s.ControlDir, "protocol-v2", "tasks", "t"+attempt.Task, name)
	return raw, path, nil
}

// SharedLease сверяет все ресурсы под общей блокировкой обеих версий фабрики.
// pending используется только до публикации попытки, затем имя владельца закрепляется.
func (s Store) SharedLease(attempt Attempt, resources []string, operation string) error {
	if (attempt.ID != "pending" && !attemptPattern.MatchString(attempt.ID)) ||
		!taskPattern.MatchString(attempt.Task) || !profilePattern.MatchString(attempt.Profile) {
		return fmt.Errorf("неверный владелец shared lease")
	}
	root, err := openControl(s.ControlDir, false)
	if err != nil {
		return err
	}
	defer root.Close()
	dir := "protocol-v2/shared-leases"
	if err := ensurePrivateDirectory(root, dir, operation == "reserve"); err != nil {
		return err
	}
	lock, err := openNamedLock(root, filepath.Join(dir, ".claim.lock"))
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := flock(lock, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("%w: shared lease занят", ErrConflict)
	}
	expected := attempt.ID
	if operation == "bind" {
		expected = "pending"
	}
	var changes []string
	for _, resource := range resources {
		file := filepath.Join(dir, digestOf([]byte(resource))+".owner")
		raw, err := readTrusted(root, file, 4096, ownerMode)
		if operation == "reserve" && errors.Is(err, os.ErrNotExist) {
			changes = append(changes, resource)
			continue
		}
		if err != nil || !bytes.Equal(raw, leaseRecord(attempt, resource, expected)) {
			return fmt.Errorf("%w: shared-ресурс %s занят или не подтверждён", ErrConflict, resource)
		}
		if operation == "bind" || operation == "release" {
			changes = append(changes, resource)
		}
	}
	for _, resource := range changes {
		file := filepath.Join(dir, digestOf([]byte(resource))+".owner")
		if operation == "release" {
			if err := root.Remove(file); err != nil {
				return err
			}
		} else if err := publishFile(root, file, leaseRecord(attempt, resource, attempt.ID),
			ownerMode, operation == "bind"); err != nil {
			return err
		}
	}
	return syncDirectory(root, dir)
}

func leaseRecord(owner Attempt, resource, id string) []byte {
	var raw strings.Builder
	fmt.Fprintf(&raw, "SCHEMA=1\nPROFILE=%s\nTASK=%s\nATTEMPT=%s\n", owner.Profile, owner.Task, id)
	encoded := base64.StdEncoding.EncodeToString([]byte(resource))
	fmt.Fprintf(&raw, "RESOURCE_HASH=%s\nRESOURCE_B64=%s\n", digestOf([]byte(resource)), encoded)
	return []byte(raw.String())
}

// FinishAttempt фиксирует terminal immutable запись перед снятием active pointer.
// Повтор с тем же результатом может завершить публикацию после обрыва.
func (s Store) FinishAttempt(attempt Attempt, terminal, reason string) error {
	if (terminal != "finished" || reason != "") &&
		(terminal != "abandoned" || !validReason(reason)) {
		return fmt.Errorf("недопустимый terminal попытки")
	}
	task, err := s.openTask(attempt.Task, true)
	if err != nil {
		return err
	}
	defer task.close()
	existing, err := task.readAttempt(attempt.Task, attempt.ID)
	if err != nil {
		return err
	}
	active, err := task.activeAttempt(attempt.Task)
	if existing.Terminal == terminal && errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || active != attempt.ID || (existing.Terminal != "" && existing.Terminal != terminal) {
		return fmt.Errorf("%w: terminal относится к другой попытке", ErrConflict)
	}
	if existing.Terminal == "" {
		value := record{"schema": 1, "protocolVersion": 2, "taskId": attempt.Task,
			"attemptId": attempt.ID, "state": terminal, "closedAt": time.Now().UTC().Format(time.RFC3339),
			"reason": nil}
		if reason != "" {
			value["reason"] = reason
		}
		raw, err := indentRecord(value)
		if err != nil {
			return err
		}
		name := filepath.Join("attempts", attempt.ID, "terminal."+digestOf(raw)+".json")
		if err := publishFile(task.root, name, raw, immutableMode, false); err != nil {
			return err
		}
	}
	if err := task.root.Remove("active-attempt.json"); err != nil {
		return err
	}
	return syncDirectory(task.root, ".")
}
