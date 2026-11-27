package state

import (
	"encoding/json"
	"fmt"
	"slices"
	"time"
)

const stageRestartTime = "2006-01-02T15:04:05.000Z"

type StageRunnerRestart struct {
	At               string           `json:"at"`
	Source           StageRunnerEpoch `json:"source"`
	RequestID        string           `json:"requestId"`
	Primary          string           `json:"primary"`
	Model            string           `json:"model"`
	Effort           string           `json:"effort"`
	Speed            *string          `json:"speed,omitempty"`
	SpeedFromProfile bool             `json:"speedFromProfile,omitempty"`
	Failover         []string         `json:"failover"`
}

func (request StageRunnerRestart) valid() bool {
	if !request.Source.Valid() || request.RequestID == "" || !runnerProvider.MatchString(request.Primary) {
		return false
	}
	if request.Speed != nil && *request.Speed != "" && !ValidRunnerSpeed(*request.Speed) {
		return false
	}
	when, err := time.Parse(stageRestartTime, request.At)
	if err != nil || when.Format(stageRestartTime) != request.At {
		return false
	}
	seen := map[string]bool{request.Primary: true}
	for _, provider := range request.Failover {
		if seen[provider] || !runnerProvider.MatchString(provider) {
			return false
		}
		seen[provider] = true
	}
	return true
}

// Selection возвращает зафиксированную пару и порядок резервов для замены.
// В сохранённом выборе узла null-поля продолжают наследовать настройки профиля.
func (request StageRunnerRestart) Selection() StageRunnerSelection {
	return StageRunnerSelection{
		Primary: request.Primary, ParametersFor: request.Primary,
		Model: &request.Model, Effort: &request.Effort, Speed: request.Speed, Failover: request.Failover,
	}
}

func (s StageRunnerSettings) restartBlocksRun(id RunIdentity) bool {
	return s.Restart != nil && s.Receipt != nil &&
		slices.Contains([]string{"pending", "consumed"}, s.Receipt.State) &&
		s.Restart.Source == (StageRunnerEpoch{ID: id.ID, Epoch: id.Epoch})
}

// PendingStageRunnerRestart читает намерение только для своей точной исходной эпохи.
// Сведения о процессе и права следующей эпохи этот читатель не меняет.
func (s Store) PendingStageRunnerRestart(id RunIdentity) (*StageRunnerRestart, error) {
	if id.Node == "" {
		return nil, nil
	}
	current, err := s.ReadStageRunnerSettings(id.stageRunnerIdentity())
	if err != nil || !current.restartBlocksRun(id) || current.Receipt.State != "pending" {
		return nil, err
	}
	return current.Restart, nil
}

// AdvanceStageRunnerRestart меняет только квитанцию принятого запроса.
// Поздний отказ или выход старой эпохи не меняет чужую квитанцию.
func (s Store) AdvanceStageRunnerRestart(
	id RunIdentity, request StageRunnerRestart, phase, reason string,
) error {
	scope := id.stageRunnerIdentity()
	if !scope.valid() || !request.valid() {
		return fmt.Errorf("settings_input: неверная identity перезапуска")
	}
	task, err := s.openTask(id.Task, true)
	if err != nil {
		return err
	}
	defer task.close()
	saved, err := task.readStageRunnerSettings(scope)
	if err != nil {
		return err
	}
	if saved.Restart == nil || saved.Restart.Source != request.Source ||
		saved.Receipt.RequestID != request.RequestID {
		return fmt.Errorf("%w: квитанция перезапуска сменилась", ErrConflict)
	}
	previous := saved.Receipt.State
	switch phase {
	case "consumed":
		if previous != "pending" || request.Source != (StageRunnerEpoch{ID: id.ID, Epoch: id.Epoch}) {
			return fmt.Errorf("%w: исходная эпоха перезапуска сменилась", ErrConflict)
		}
	case "started":
		if previous != "consumed" || id.Epoch <= request.Source.Epoch || id.ID == request.Source.ID {
			return fmt.Errorf("%w: новая эпоха перезапуска не подтверждена", ErrConflict)
		}
	case "failed":
		if previous != "pending" && previous != "consumed" {
			return nil
		}
	default:
		return fmt.Errorf("settings_input: неверная фаза перезапуска")
	}
	saved.Receipt.State, saved.Receipt.Reason = phase, reason
	return task.publishStageRunnerSettings(scope, saved)
}

func decodeStageRunnerRestart(row record, receipt *StageRunnerReceipt) (*StageRunnerRestart, error) {
	value, exists := row["goRestart"]
	if !exists {
		return nil, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var request StageRunnerRestart
	if err := json.Unmarshal(raw, &request); err != nil || !request.valid() ||
		receipt == nil || receipt.RequestID != request.RequestID {
		return nil, fmt.Errorf("settings_corrupt: неверная запись перезапуска")
	}
	return &request, nil
}
