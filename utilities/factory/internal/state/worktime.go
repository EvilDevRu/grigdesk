package state

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

type WorkTime struct {
	Work, Gate, Last int64
}

// ReadWorkTime читает часы из проверенных событий точной открытой попытки.
// Закрытая попытка использует свою сохранённую проекцию, как прежний reader.
func (s Store) ReadWorkTime(task, id, profile, routesDir string) (WorkTime, error) {
	if !attemptPattern.MatchString(id) {
		return WorkTime{}, fmt.Errorf("work-time: нужна точная попытка")
	}
	t, err := s.openTask(task, false)
	if err != nil {
		return WorkTime{}, err
	}
	defer t.close()
	attempt, err := t.readAttempt(task, id)
	if err != nil {
		return WorkTime{}, err
	}
	if (profile != "" && profile != attempt.Profile) ||
		(routesDir != "" && routesDir != attempt.RoutesDir) {
		return WorkTime{}, fmt.Errorf("%w: identity work-time", ErrConflict)
	}
	if attempt.Terminal != "" {
		return s.projectedWorkTime(task, id)
	}
	ledger, dir, err := t.loadStage(task, id, false)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return WorkTime{}, err
	}
	return ledger.workTime()
}

func (l stageLedger) workTime() (WorkTime, error) {
	var result WorkTime
	executors := make(map[string]string)
	nodes, _ := l.bundle.Machine["nodes"].([]any)
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		executors[stringField(node, "id")] = stringField(node, "executor")
	}
	intervals := []string{"commit", "rewind-limit", "no-progress", "loop-ceiling"}
	for i, event := range l.events {
		row := event.Data
		at, err := time.Parse(time.RFC3339, stringField(row, "at"))
		if err != nil || at.Unix() < 0 {
			return WorkTime{}, fmt.Errorf("неверное время stage event")
		}
		kind := stringField(row, "kind")
		recovery := kind == "commit" && stringField(row, "outcome") != "rejected" &&
			stringField(row, "reason") == "узел не исполнялся: при восстановлении снята инструментация"
		if i > 0 && slices.Contains(intervals, kind) && !recovery {
			elapsed := max(0, at.Unix()-result.Last)
			switch executors[stringField(row, "node")] {
			case "agent", "command":
				result.Work += elapsed
			case "gate":
				result.Gate += elapsed
			default:
				return WorkTime{}, fmt.Errorf("stage event относится к неизвестному executor")
			}
		}
		result.Last = at.Unix()
	}
	return result, nil
}

func (s Store) projectedWorkTime(task, id string) (WorkTime, error) {
	root, err := openControl(s.StateDir, false)
	if err != nil {
		return WorkTime{}, err
	}
	defer root.Close()
	_, raw, err := findProjection(root, "t"+task+".pipeline")
	if err != nil {
		return WorkTime{}, err
	}
	fields := make(map[string]string)
	for line := range strings.SplitSeq(string(raw), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			fields[key] = value
		}
	}
	work, err := strconv.ParseUint(fields["WORK_TIME_S"], 10, 63)
	if err != nil || fields["ATTEMPT_ID"] != id {
		return WorkTime{}, fmt.Errorf("нет данных о времени: журнал попытки sealed и проекция не построена")
	}
	gate, _ := strconv.ParseUint(fields["GATE_WAIT_S"], 10, 63)
	last, _ := strconv.ParseUint(fields["WORK_TIMER_SINCE"], 10, 63)
	return WorkTime{Work: int64(work), Gate: int64(gate), Last: int64(last)}, nil
}
