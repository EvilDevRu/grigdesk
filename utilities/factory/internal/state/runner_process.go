package state

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

// PublishRunnerProcess связывает удержанный launcher с точной активной эпохой.
// Снятие записи после выхода сверяет исходные байты под тем же task lock.
func (s Store) PublishRunnerProcess(
	id RunIdentity, provider string, pid int, start string,
) (func() error, error) {
	stamp, invalid := strconv.ParseUint(start, 10, 64)
	if !profilePattern.MatchString(provider) || pid <= 1 ||
		invalid != nil || strconv.FormatUint(stamp, 10) != start {
		return nil, fmt.Errorf("неверная identity процесса исполнителя")
	}
	run, _, err := s.openRun(id, true)
	if err != nil {
		return nil, err
	}
	defer run.close()
	current, _, rc, err := run.readCurrent(id)
	if rc != 0 || err != nil || current.State != "active" {
		return nil, fmt.Errorf("эпоха исполнителя больше не активна")
	}
	const directory = "runner-processes"
	if err := ensurePrivateDirectory(run.root, directory, true); err != nil {
		return nil, err
	}
	file := filepath.Join(directory, "t"+id.Task+".active")
	data := fmt.Appendf(nil, "SCHEMA=1\nTASK=%s\nSTAGE=%s\nRUN_ID=%s\nEPOCH=%d\n",
		id.Task, id.Stage, id.ID, id.Epoch)
	data = fmt.Appendf(data, "RUNNER=%s\nPID=%d\nPGID=%d\nSESSION=%d\nSTARTTIME=%s\nSTATE=active\n",
		provider, pid, pid, pid, start)
	if err := publishFile(run.root, file, data, ownerMode, true); err != nil {
		return nil, err
	}
	return func() error {
		return s.clearRunnerProcess(id.Task, file, data)
	}, nil
}

// clearRunnerProcess не трогает запись следующей эпохи даже при позднем выходе.
// Ошибку чтения нельзя считать доказательством отсутствия владельца.
func (s Store) clearRunnerProcess(task, file string, expected []byte) error {
	lock, err := s.openTask(task, true)
	if err != nil {
		return err
	}
	defer lock.close()
	root, err := openControl(s.ControlDir, false)
	if err != nil {
		return err
	}
	defer root.Close()
	actual, err := readTrusted(root, file, int64(len(expected))+1, ownerMode)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(actual, expected) {
		return nil
	}
	if err := root.Remove(file); err != nil {
		return err
	}
	return host.SyncDirectory(root, filepath.Dir(file))
}
