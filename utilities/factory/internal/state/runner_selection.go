package state

import (
	"encoding/json"
	"fmt"
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
	Failover               []string
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
	if !exactFields(selection, "primary", "parametersFor", "model", "effort") {
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
