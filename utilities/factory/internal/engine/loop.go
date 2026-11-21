package engine

import (
	"errors"
	"fmt"
	"strconv"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

// loopLimit возвращает снимок изменяемого потолка цикла из профиля.
// Пропущенная настройка имеет прежнее значение 20, пустая считается ошибкой.
func (e execution) loopLimit() (int64, error) {
	if e.bundle.Machine["loop"] == nil {
		return 0, nil
	}
	configured := e.workspace.LoopRounds
	if configured == nil {
		return 20, nil
	}
	count, err := strconv.ParseInt(*configured, 10, 64)
	if err != nil || count < 1 || count > 300 || strconv.FormatInt(count, 10) != *configured {
		return 0, fmt.Errorf("PROFILE_LOOP_MAX_ROUNDS: нужно целое 1..300")
	}
	return count, nil
}

func (e execution) continueLoop(cursor state.StageSnapshot) (state.StageSnapshot, int, error) {
	if cursor.State != "stopped" || cursor.Stop != "loop-ceiling" {
		return cursor, 0, nil
	}
	limit, err := e.loopLimit()
	if err != nil {
		return cursor, 78, err
	}
	if limit == 0 {
		return cursor, 78, fmt.Errorf("остановка loop-ceiling без закреплённого loop")
	}
	next, rc, err := e.request.Store.ContinueLoop(e.attempt.Task, e.attempt.ID, cursor, limit)
	if rc == 11 {
		fault := e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"})
		if fault != nil {
			return cursor, 78, errors.Join(err, fault)
		}
		return cursor, 75, err
	}
	return next, rc, err
}
