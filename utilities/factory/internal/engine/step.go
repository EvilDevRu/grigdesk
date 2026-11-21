package engine

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

// dispatch читает executor из закреплённой машины на каждом переходе.
// Состояние cursor и typed verdict определяют маршрут до следующего ожидания.
func (e *execution) dispatch(ctx context.Context, cursor state.StageSnapshot) (code int, failure error) {
	defer func() {
		if code != 130 || !errors.Is(failure, context.Canceled) {
			return
		}
		if err := e.cleanupStoppedZone(ctx, cursor); err != nil {
			mark := e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"})
			code, failure = 75, errors.Join(err, mark)
		}
	}()
	for cursor.State != "stopped" {
		if err := ctx.Err(); err != nil {
			return 130, err
		}
		node := e.findNode(cursor.CurrentNode)
		key, _ := node["runKey"].(string)
		switch node["executor"] {
		case "gate":
			return e.waitAtGate(cursor, key)
		case "command":
			var rc int
			var err error
			cursor, rc, err = e.runCommand(ctx, cursor, node, key)
			if err != nil {
				if rc == 130 && errors.Is(err, context.Canceled) {
					return rc, err
				}
				mark := e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"})
				if mark != nil {
					return 78, mark
				}
				return rc, err
			}
		case "agent":
			var rc int
			var err error
			cursor, rc, err = e.runAgent(ctx, cursor, node, key)
			if err != nil {
				if rc == 130 && errors.Is(err, context.Canceled) {
					return rc, err
				}
				if fault := e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"}); fault != nil {
					return 78, fault
				}
				return rc, err
			}
		default:
			return 78, fmt.Errorf("executor узла %s отсутствует в pin", cursor.CurrentNode)
		}
	}
	if cursor.Stop == "human" || cursor.Stop == "rewind-limit" ||
		cursor.Stop == "no-progress" || cursor.Stop == "loop-ceiling" {
		return projectResult(e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"}))
	}
	if rc, err := e.checkNoActiveTransaction(); err != nil {
		mark := e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"})
		return rc, errors.Join(err, mark)
	}
	a := e.attempt
	timing, err := e.request.Store.ReadWorkTime(a.Task, a.ID, a.Profile, a.RoutesDir)
	if err != nil {
		return projectResult(err)
	}
	fields := []state.ProjectionField{
		{Key: "WORK_TIME_S", Value: strconv.FormatInt(timing.Work, 10)},
		{Key: "GATE_WAIT_S", Value: strconv.FormatInt(timing.Gate, 10)},
		{Key: "WORK_TIMER_SINCE", Value: strconv.FormatInt(timing.Last, 10)},
	}
	if err := e.project(fields...); err != nil {
		return projectResult(err)
	}
	if err := e.request.Store.FinishAttempt(e.attempt, "finished", ""); err != nil {
		return projectResult(err)
	}
	if e.workspace.Mode == "shared" {
		if err := e.request.Store.SharedLease(e.attempt, e.workspace.Resources, "release"); err != nil {
			mark := e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"},
				state.ProjectionField{Key: "RESULT", Value: "lease-release-failed"})
			writeRouteLog(e.request, "маршрут завершён, но shared lease не освобождён")
			return projectResult(errors.Join(err, mark))
		}
	}
	if err := e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "0"},
		state.ProjectionField{Key: "RESULT", Value: "completed"}); err != nil {
		return projectResult(err)
	}
	writeRouteLog(e.request, "маршрут завершён; хвост маршрута подтверждён")
	return 0, nil
}

func (e execution) findNode(id string) map[string]any {
	nodes, _ := e.bundle.Machine["nodes"].([]any)
	for _, value := range nodes {
		node, _ := value.(map[string]any)
		if node["id"] == id {
			return node
		}
	}
	return nil
}
