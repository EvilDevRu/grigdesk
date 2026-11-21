package state

import (
	"encoding/json"
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"time"
)

type StageRunnerIdentity struct {
	Task    string `json:"task"`
	Profile string `json:"profile"`
	Attempt string `json:"attempt"`
	Node    string `json:"node"`
	Stage   string `json:"stage"`
}

type StageRunnerReceipt struct {
	RequestID   string `json:"requestId"`
	PayloadHash string `json:"payloadHash,omitempty"`
	State       string `json:"state"`
	Reason      string `json:"reason"`
}

type StageRunnerSettings struct {
	Selection StageRunnerSelection
	Revision  uint64
	Receipt   *StageRunnerReceipt
	Restart   *StageRunnerRestart
}

func (id StageRunnerIdentity) valid() bool {
	return taskPattern.MatchString(id.Task) && profilePattern.MatchString(id.Profile) &&
		attemptPattern.MatchString(id.Attempt) && runnerNode.MatchString(id.Node) &&
		runStagePattern.MatchString(id.Stage)
}

// ReadStageRunnerSettings возвращает запись для активной попытки, включая квитанцию записи.
// Запуск использует те же защищённые байты через ReadStageRunnerSelection.
func (s Store) ReadStageRunnerSettings(id StageRunnerIdentity) (StageRunnerSettings, error) {
	if !id.valid() {
		return StageRunnerSettings{}, fmt.Errorf("identity_conflict: неверная identity настроек")
	}
	task, err := s.openTask(id.Task, false)
	if err != nil {
		return StageRunnerSettings{}, err
	}
	defer task.close()
	return task.readStageRunnerSettings(id)
}

func (t *taskState) readStageRunnerSettings(id StageRunnerIdentity) (StageRunnerSettings, error) {
	var result StageRunnerSettings
	active, err := t.activeAttempt(id.Task)
	if err != nil || active != id.Attempt {
		return result, fmt.Errorf("%w: попытка настроек сменилась", ErrConflict)
	}
	owner := filepath.Join("attempts", id.Attempt)
	if err := ensurePrivateDirectory(t.root, owner, false); err != nil {
		return result, err
	}
	directory := filepath.Join(owner, "runner-settings")
	if err := ensurePrivateDirectory(t.root, directory, false); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return result, nil
		}
		return result, err
	}
	raw, err := readTrusted(t.root, filepath.Join(directory, id.Node+".json"), metadataBytes, ownerMode)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	return decodeStageRunnerSettings(raw, id)
}

// decodeStageRunnerSettings читает selection и CAS из одного проверенного объекта.
// Сохранённая квитанция без payloadHash доступна для чтения, но не подтверждает replay.
func decodeStageRunnerSettings(raw []byte, id StageRunnerIdentity) (StageRunnerSettings, error) {
	var result StageRunnerSettings
	fields, err := decodeRecord(raw)
	if err != nil || !jsontext.Value(raw).IsValid() {
		return result, fmt.Errorf("settings_corrupt: неверный формат настроек узла %s", id.Node)
	}
	revision, _ := fields["revision"].(json.Number)
	number, err := strconv.ParseUint(string(revision), 10, 53)
	if err != nil || number == 0 {
		return result, fmt.Errorf("settings_corrupt: неверная revision узла %s", id.Node)
	}
	result.Selection, err = decodeStageRunnerSelection(fields, id)
	if err != nil {
		return result, err
	}
	result.Revision = number
	if receipt := objectField(fields, "receipt"); receipt != nil {
		result.Receipt = &StageRunnerReceipt{
			RequestID: stringField(receipt, "requestId"), PayloadHash: stringField(receipt, "payloadHash"),
			State: stringField(receipt, "state"), Reason: stringField(receipt, "reason"),
		}
		if !slices.Contains([]string{"saved", "pending", "consumed", "started", "failed", "stale"},
			result.Receipt.State) {
			return result, fmt.Errorf("settings_corrupt: неизвестное состояние квитанции")
		}
	}
	result.Restart, err = decodeStageRunnerRestart(fields, result.Receipt)
	return result, err
}

// SaveStageRunnerSettings сериализует правку с запуском задачи или проверяет её живую эпоху.
// Под task lock повторно проверяются terminal, receipt, revision и снимок политики редактора.
func (s Store) SaveStageRunnerSettings(
	id StageRunnerIdentity, revision uint64, expectedRun *StageRunnerEpoch, selection StageRunnerSelection,
	receipt StageRunnerReceipt, restart *StageRunnerRestart, validatePolicy func() error,
) (StageRunnerSettings, error) {
	var result StageRunnerSettings
	if restart != nil {
		restart.At = time.Now().UTC().Format(stageRestartTime)
	}
	if !id.valid() || !digestPattern.MatchString(receipt.PayloadHash) ||
		(restart == nil && receipt.State != "saved") ||
		(restart != nil && (expectedRun == nil || !restart.valid() ||
			*expectedRun != restart.Source || receipt.State != "pending" || receipt.RequestID != restart.RequestID)) {
		return result, fmt.Errorf("settings_input: неверная запись")
	}
	if expectedRun == nil {
		orchestrator, rc, err := s.LockOrchestrator(id.Task)
		if err != nil {
			if rc == 73 {
				err = fmt.Errorf("%w: identity_conflict: оркестратор ещё работает", ErrConflict)
			}
			return result, err
		}
		defer orchestrator.Close()
	}
	task, err := s.openTask(id.Task, true)
	if err != nil {
		return result, err
	}
	defer task.close()
	attempt, err := task.readAttempt(id.Task, id.Attempt)
	if err != nil {
		return result, err
	}
	if attempt.Profile != id.Profile || attempt.Terminal != "" {
		return result, fmt.Errorf("%w: попытка настроек завершена или сменилась", ErrConflict)
	}
	current, err := task.readStageRunnerSettings(id)
	if err != nil {
		return result, err
	}
	if replay, err := current.Replay(receipt); replay || err != nil {
		return current, err
	}
	if current.Restart != nil && slices.Contains([]string{"pending", "consumed"}, current.Receipt.State) {
		return result, fmt.Errorf("%w: restart_pending: перезапуск ещё выполняется", ErrConflict)
	}
	if current.Revision != revision || revision >= lifecycleIntegerMax {
		return result, fmt.Errorf("%w: revision_conflict: настройки уже изменены", ErrConflict)
	}
	if err := validatePolicy(); err != nil {
		return result, err
	}
	if err := s.requireNoLegacySwitch(id); err != nil {
		return result, err
	}
	if expectedRun != nil {
		actual, err := s.readStageRunnerActual(task, id)
		if err != nil {
			return result, err
		}
		if actual == nil || actual.Run != *expectedRun {
			return result, fmt.Errorf("%w: identity_conflict: работающий запуск сменился", ErrConflict)
		}
	}
	result = StageRunnerSettings{
		Selection: selection, Revision: revision + 1, Receipt: &receipt, Restart: restart,
	}
	return result, task.publishStageRunnerSettings(id, result)
}

// publishStageRunnerSettings заменяет только exact sidecar под task lock.
// Квитанция, сохранённый выбор и намерение перезапуска записываются одним rename.
func (t *taskState) publishStageRunnerSettings(id StageRunnerIdentity, value StageRunnerSettings) error {
	selection := value.Selection
	wire := record{
		"primary": nil, "parametersFor": selection.ParametersFor,
		"model": selection.Model, "effort": selection.Effort,
	}
	var failover []string
	if selection.Primary != "" {
		wire["primary"] = selection.Primary
		failover = append([]string{}, selection.Failover...)
	}
	entry := record{
		"schema": 1, "identity": id, "revision": value.Revision,
		"selection": wire, "failover": failover, "receipt": value.Receipt,
	}
	if value.Restart != nil {
		entry["goRestart"] = value.Restart
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	if _, err := decodeStageRunnerSettings(raw, id); err != nil {
		return err
	}
	directory := filepath.Join("attempts", id.Attempt, "runner-settings")
	if err := ensurePrivateDirectory(t.root, directory, true); err != nil {
		return err
	}
	file := filepath.Join(directory, id.Node+".json")
	return publishFile(t.root, file, raw, ownerMode, true)
}

// Replay допускает повтор того же запроса, пока его receipt остаётся последним.
// Равный requestId с другим payload отражает конфликт даже при прежней revision.
func (s StageRunnerSettings) Replay(receipt StageRunnerReceipt) (bool, error) {
	if s.Receipt == nil || s.Receipt.RequestID != receipt.RequestID {
		return false, nil
	}
	if s.Receipt.PayloadHash != receipt.PayloadHash {
		return false, fmt.Errorf("%w: request_conflict: другой payload с прежним requestId", ErrConflict)
	}
	return true, nil
}

// requireNoLegacySwitch сохраняет незавершённый запрос предыдущего поколения.
// Отсутствие файла разрешает новую правку, повреждённую запись должен разобрать владелец.
func (s Store) requireNoLegacySwitch(id StageRunnerIdentity) error {
	root, err := openControl(s.ControlDir, false)
	if err != nil {
		return err
	}
	defer root.Close()
	directory := filepath.Join("requests", "t"+id.Task)
	if err := ensurePrivateDirectory(root, directory, false); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	raw, err := readTrusted(root, filepath.Join(directory, id.Stage+".switch"), runRecordLimit, ownerMode)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	fields, err := parseRunFields(raw)
	if err != nil {
		return err
	}
	if fields["STATE"] == "pending" {
		return fmt.Errorf("%w: restart_pending: другое переключение ожидает выполнения", ErrConflict)
	}
	return nil
}
