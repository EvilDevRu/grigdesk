package engine

import "grigdesk.local/tools/utilities/factory/internal/state"

// waitAtGate публикует pause в доверенном ledger, затем отражает его в витрине.
// Повторный resume на ожидающем узле не открывает второй visit.
func (e execution) waitAtGate(cursor state.StageSnapshot, key string) (int, error) {
	if _, err := e.request.Store.PauseStage(e.attempt.Task, e.attempt.ID, cursor,
		"human gate: "+cursor.CurrentNode); err != nil {
		return projectResult(err)
	}
	return projectResult(e.project(
		state.ProjectionField{Key: key, Value: "waiting"},
		state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"},
	))
}
