package state

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var runnerNode = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,40}$`)
var runnerProvider = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

type StageRunnerSelection struct {
	Primary, ParametersFor string
	Model, Effort          *string
	Speed                  *string
	Failover               []string
}

// StageSelectionAdmission связывает новую эпоху со снимком редактора или restart.
// Для restart сверяется однократно потреблённое намерение этой же попытки.
type StageSelectionAdmission struct {
	Selection StageRunnerSelection
	Restart   *StageRunnerRestart
}

// CheckStageAdmissionSelection проверяет снимок до отказа или смены кандидата.
// Проверка сериализована с сохранением настроек и сама не выдаёт эпоху.
func (s Store) CheckStageAdmissionSelection(id StageRunnerIdentity, expected StageSelectionAdmission) error {
	if !id.valid() {
		return ErrConflict
	}
	task, err := s.openTask(id.Task, false)
	if err != nil {
		return err
	}
	defer task.close()
	attempt, err := task.readAttempt(id.Task, id.Attempt)
	if err != nil {
		return err
	}
	if attempt.Profile != id.Profile || attempt.Terminal != "" {
		return ErrConflict
	}
	return task.checkStageAdmissionSelection(id, expected)
}

// checkStageAdmissionSelection работает под уже открытой блокировкой задачи.
// Выдача эпохи и отрицательное решение используют одно сравнение.
func (t *taskState) checkStageAdmissionSelection(
	id StageRunnerIdentity, expected StageSelectionAdmission,
) error {
	current, err := t.readStageRunnerSettings(id)
	if err != nil {
		return err
	}
	if expected.Restart == nil {
		if reflect.DeepEqual(current.Selection, expected.Selection) {
			return nil
		}
	} else if current.Restart != nil && current.Receipt != nil && current.Receipt.State == "consumed" &&
		current.Restart.Source == expected.Restart.Source &&
		current.Restart.RequestID == expected.Restart.RequestID &&
		reflect.DeepEqual(current.Restart.Selection(), expected.Selection) {
		return nil
	}
	return fmt.Errorf("%w: settings_conflict: выбор исполнителя изменился до запуска", ErrConflict)
}

// ReadStageRunnerSelection читает параметры ранее сохранённого точного узла.
// Отсутствие записи означает наследование, незавершённый restart требует восстановления.
func (s Store) ReadStageRunnerSelection(
	attempt Attempt, node, stage string,
) (StageRunnerSelection, error) {
	id := StageRunnerIdentity{Task: attempt.Task, Profile: attempt.Profile, Attempt: attempt.ID,
		Node: node, Stage: stage}
	settings, err := s.ReadStageRunnerSettings(id)
	if settings.Restart != nil && slices.Contains([]string{"pending", "consumed"}, settings.Receipt.State) {
		return StageRunnerSelection{}, fmt.Errorf("%w: перезапуск узла %s ещё не подтверждён", ErrConflict, node)
	}
	return settings.Selection, err
}

// decodeStageRunnerSelection проверяет прежний формат вместе с exact identity.
// Сохранённые параметры применяются только к названному исполнителю.
func decodeStageRunnerSelection(
	row record, id StageRunnerIdentity,
) (StageRunnerSelection, error) {
	var result StageRunnerSelection
	conflict := fmt.Errorf("неверная запись настроек узла %s", id.Node)
	owner := objectField(row, "identity")
	if row["schema"] != json.Number("1") || !exactFields(owner, "task", "profile", "attempt", "node", "stage") ||
		owner["task"] != id.Task || owner["profile"] != id.Profile || owner["attempt"] != id.Attempt ||
		owner["node"] != id.Node || owner["stage"] != id.Stage {
		return result, conflict
	}
	if pending, exists := row["pending"]; exists {
		phase, _ := pending.(map[string]any)
		status, _ := phase["state"].(string)
		if !slices.Contains([]string{"consumed", "started", "failed", "stale"}, status) {
			return result, fmt.Errorf("%w: у узла %s есть незавершённое переключение", ErrConflict, id.Node)
		}
	}
	selection := objectField(row, "selection")
	keys := []string{"primary", "parametersFor", "model", "effort"}
	if _, present := selection["speed"]; present {
		keys = append(keys, "speed")
	}
	if !exactFields(selection, keys...) {
		return result, conflict
	}
	result.ParametersFor = stringField(selection, "parametersFor")
	if !runnerProvider.MatchString(result.ParametersFor) {
		return result, conflict
	}
	if primary := selection["primary"]; primary != nil {
		value, ok := primary.(string)
		if !ok || value != result.ParametersFor {
			return result, conflict
		}
		result.Primary = value
	}
	var err error
	if result.Model, err = nullableRunnerText(selection["model"]); err != nil {
		return result, conflict
	}
	if result.Effort, err = nullableRunnerText(selection["effort"]); err != nil {
		return result, conflict
	}
	result.Speed, err = nullableRunnerText(selection["speed"])
	if err != nil || (result.Speed != nil && !ValidRunnerSpeed(*result.Speed)) {
		return result, conflict
	}
	if row["failover"] != nil {
		chain, ok := row["failover"].([]any)
		if !ok || result.Primary == "" {
			return result, conflict
		}
		for _, item := range chain {
			value, ok := item.(string)
			if !ok || !runnerProvider.MatchString(value) || value == result.Primary ||
				slices.Contains(result.Failover, value) {
				return result, conflict
			}
			result.Failover = append(result.Failover, value)
		}
	}
	return result, nil
}

// ValidRunnerSpeed принимает публичный enum при чтении запроса или защищённой записи.
// Наследование кодируется отдельно и не является значением скорости.
func ValidRunnerSpeed(value string) bool {
	return value == "standard" || value == "fast" || value == "ultrafast"
}

func nullableRunnerText(value any) (*string, error) {
	if value == nil {
		return nil, nil
	}
	text, ok := value.(string)
	unsafe := strings.ContainsFunc(text, func(r rune) bool {
		return r < 32
	})
	if !ok || utf8.RuneCountInString(text) > 2048 || unsafe {
		return nil, fmt.Errorf("неверное значение параметра исполнителя")
	}
	return &text, nil
}
