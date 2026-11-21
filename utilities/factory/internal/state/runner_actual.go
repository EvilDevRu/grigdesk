package state

import (
	"encoding/json"
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

type StageRunnerEpoch struct {
	ID    string `json:"id"`
	Epoch uint64 `json:"epoch"`
}

type StageRunnerActual struct {
	Run      StageRunnerEpoch `json:"run"`
	Provider string           `json:"provider"`
	Model    string           `json:"model"`
	Effort   string           `json:"effort"`
}

// Valid проверяет допустимость id и эпохи до использования в сравнении CAS.
// Обе величины передаются API без нормализации.
func (run StageRunnerEpoch) Valid() bool {
	return runIDPattern.MatchString(run.ID) && run.ID != "." && run.ID != ".." &&
		run.Epoch > 0 && run.Epoch <= lifecycleIntegerMax
}

type stageRunnerProcess struct {
	Schema int
	ID     RunIdentity
	Node   string
	Owner  host.ProcessIdentity
	Actual StageRunnerActual
}

// PublishStageRunnerProcess записывает параметры от владельца до выдачи permit.
// Проекция логов провайдера не участвует в выборе actual и проверке эпохи.
func (s Store) PublishStageRunnerProcess(
	id RunIdentity, node, provider, model, effort string, owner host.ProcessIdentity,
) (func() error, error) {
	if !runnerNode.MatchString(node) || !runnerProvider.MatchString(provider) ||
		owner.PID <= 1 || owner.Session != owner.PID || owner.Group != owner.PID ||
		owner.Start == "" || owner.Boot == "" {
		return nil, fmt.Errorf("неверная identity запуска узла")
	}
	handle, _, err := s.openRun(id, true)
	if err != nil {
		return nil, err
	}
	defer handle.close()
	current, _, rc, err := handle.readCurrent(id)
	if rc != 0 || err != nil || current.State != "active" {
		return nil, fmt.Errorf("эпоха исполнителя больше не активна")
	}
	entry := stageRunnerProcess{Schema: 1, ID: id, Node: node, Owner: owner}
	entry.Actual.Run.ID, entry.Actual.Run.Epoch = id.ID, id.Epoch
	entry.Actual.Provider, entry.Actual.Model, entry.Actual.Effort = provider, model, effort
	raw, err := json.Marshal(entry)
	if err != nil || len(raw) > runRecordLimit {
		return nil, fmt.Errorf("неверные параметры запуска узла")
	}
	const directory = "runner-processes"
	if err := ensurePrivateDirectory(handle.root, directory, true); err != nil {
		return nil, err
	}
	file := stageRunnerProcessPath(id.Task)
	if err := publishFile(handle.root, file, raw, ownerMode, true); err != nil {
		return nil, err
	}
	return func() error { return s.clearRunnerProcess(id.Task, file, raw) }, nil
}

func stageRunnerProcessPath(task string) string {
	return filepath.Join("runner-processes", "t"+task+".go.json")
}

// ReadStageRunnerActual подтверждает exact node, живую эпоху и identity процесса.
// Старые записи и завершённые процессы не выступают текущим запуском.
func (s Store) ReadStageRunnerActual(id StageRunnerIdentity) (*StageRunnerActual, error) {
	if !id.valid() {
		return nil, fmt.Errorf("identity_conflict: неверная identity настроек")
	}
	task, err := s.openTask(id.Task, false)
	if err != nil {
		return nil, err
	}
	defer task.close()
	active, err := task.activeAttempt(id.Task)
	if err != nil || active != id.Attempt {
		return nil, fmt.Errorf("%w: попытка настроек сменилась", ErrConflict)
	}
	return s.readStageRunnerActual(task, id)
}

// readStageRunnerActual оставляет проверку внутри уже взятого task lock.
// Писатель связывает сохранение с той же эпохой, которую показало чтение.
func (s Store) readStageRunnerActual(task *taskState, id StageRunnerIdentity) (*StageRunnerActual, error) {
	root, err := openControl(s.ControlDir, false)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err := ensurePrivateDirectory(root, "runner-processes", false); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	raw, err := readTrusted(root, stageRunnerProcessPath(id.Task), runRecordLimit, ownerMode)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var entry stageRunnerProcess
	if !jsontext.Value(raw).IsValid() || json.Unmarshal(raw, &entry) != nil ||
		entry.Schema != 1 || entry.ID.Task != id.Task || !entry.ID.Valid() ||
		!runnerNode.MatchString(entry.Node) || !runnerProvider.MatchString(entry.Actual.Provider) ||
		entry.ID.ID != entry.Actual.Run.ID || entry.ID.Epoch != entry.Actual.Run.Epoch {
		return nil, fmt.Errorf("settings_corrupt: неверная запись процесса")
	}
	if entry.ID.Attempt != id.Attempt || entry.Node != id.Node || entry.ID.Stage != id.Stage {
		return nil, nil
	}
	name := filepath.Join("runs", "t"+id.Task, id.Stage+".active")
	handle := runHandle{task: task, root: root, name: name}
	run, _, rc, err := handle.readCurrent(entry.ID)
	if rc == 73 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if run.State != "active" || !host.StillRunning(entry.Owner) {
		return nil, nil
	}
	return &entry.Actual, nil
}
