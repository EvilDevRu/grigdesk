package engine

import (
	"errors"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

// beginScoutSpan фиксирует разведку отдельно от первого визита основного маршрута.
// У визита SCOUT ещё нет stage head. Связь с route pin остаётся неизменной.
func (e execution) beginScoutSpan() (func(int) error, error) {
	hostID, err := host.CurrentIdentity()
	if err != nil {
		return nil, err
	}
	session := commandVisit{boot: hostID.Boot, session: lifeID("os")}
	history, err := e.request.Store.ReadLifecycle(e.attempt.Task, e.attempt.ID)
	if err != nil {
		return nil, err
	}
	pinned := false
	for _, event := range history {
		pinned = pinned || event.Data["kind"] == "route_selected"
	}
	if !pinned {
		if err := e.recordRouteSelected(session); err != nil {
			return nil, err
		}
	}
	span := lifeID("sp")
	started := time.Now()
	if err := e.appendLife(session, "bootstrap_started", span, map[string]any{
		"bootstrapId": "scout", "catalogHash": e.attempt.CatalogHash,
	}); err != nil {
		return nil, err
	}
	visit := session
	visit.visit, visit.visitSpan = lifeID("nv"), lifeID("sp")
	visit.node, visit.key = "scout", "SCOUT"
	if err := e.appendLife(visit, "node_visit_started", visit.visitSpan, map[string]any{
		"visitReason": "initial", "cursorOrdinal": 0, "transitionId": nil, "stageEventHash": nil,
	}); err != nil {
		return nil, errors.Join(err, e.finishScoutSpan(session, span, started, 78))
	}
	return func(code int) error {
		finished := scoutSpanDetails(started, code)
		finished["exitKind"] = "attempt_interrupted"
		if code == 0 || code == 22 {
			finished["exitKind"] = "forward_transition"
		}
		finished["transitionId"], finished["stageEventHash"] = nil, nil
		return errors.Join(e.appendLife(visit, "node_visit_finished", visit.visitSpan, finished),
			e.finishScoutSpan(session, span, started, code))
	}, nil
}

func (e execution) finishScoutSpan(session commandVisit, span string, started time.Time, code int) error {
	return e.appendLife(session, "bootstrap_finished", span, scoutSpanDetails(started, code))
}

// scoutSpanDetails различает завершённую разведку, ожидание человека и остановку процесса.
// Причины провайдера остаются в журнале визита и не записываются как свободный текст telemetry.
func scoutSpanDetails(started time.Time, code int) map[string]any {
	status, reason := "failed", "unavailable"
	switch code {
	case 0:
		status, reason = "succeeded", "normal"
	case 22:
		reason = "manual_resume"
	case 130:
		status, reason = "interrupted", "signal"
	}
	return map[string]any{
		"status": status, "reasonCode": reason, "reasonTextSha256": nil,
		"durationMs":       time.Since(started).Milliseconds(),
		"durationFidelity": "derived", "evidenceSha256": nil,
	}
}
