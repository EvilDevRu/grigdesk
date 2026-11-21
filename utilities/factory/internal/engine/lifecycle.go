package engine

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

const lifecycleTime = "2006-01-02T15:04:05.000Z"

type commandVisit struct {
	boot, session, visit, execution string
	visitSpan, commandSpan          string
	node, key                       string
	ordinal                         int64
}

// beginCommandVisit фиксируется до передачи управления хуку.
// Повтор над тем же head с уже начатой командой требует решения человека.
func (e execution) beginCommandVisit(
	cursor state.StageSnapshot, key, command string,
) (commandVisit, int, error) {
	visit := commandVisit{node: cursor.CurrentNode, key: key, ordinal: cursor.Sequence}
	a := e.attempt
	events, err := e.request.Store.ReadLifecycle(a.Task, a.ID)
	if err != nil {
		return visit, 78, err
	}
	pinWritten := false
	previousVisits := make(map[string]bool)
	for _, event := range events {
		value := event.Data
		if value["kind"] == "route_selected" {
			pinWritten = true
		}
		if value["kind"] == "node_visit_started" && value["nodeId"] == cursor.CurrentNode {
			details, _ := value["details"].(map[string]any)
			id, _ := value["nodeVisitId"].(string)
			if details["stageEventHash"] == cursor.HeadEventHash {
				previousVisits[id] = true
			}
		}
		if value["kind"] == "command_started" {
			id, _ := value["nodeVisitId"].(string)
			if previousVisits[id] {
				return visit, 75, fmt.Errorf("исход предыдущего вызова не подтверждён; нужен явный goto")
			}
		}
	}
	identity, err := host.CurrentIdentity()
	if err != nil {
		return visit, 78, err
	}
	visit.boot = identity.Boot
	visit.session, visit.visit, visit.execution = lifeID("os"), lifeID("nv"), lifeID("ne")
	visit.visitSpan, visit.commandSpan = lifeID("sp"), lifeID("sp")
	if !pinWritten {
		if err := e.recordRouteSelected(visit); err != nil {
			return visit, 78, err
		}
	}
	if err := e.recordNodeVisit(visit, cursor); err != nil {
		return visit, 78, err
	}
	digest := lifecycleDigest(a.CatalogHash + "|" + a.RouteHash + "|" + cursor.CurrentNode + "|" + command)
	details := map[string]any{"commandKind": "profile_hook", "commandContractSha256": digest}
	err = e.appendLife(visit, "command_started", visit.commandSpan, details)
	if err != nil {
		return visit, 78, err
	}
	return visit, 0, nil
}

// recordRouteSelected переносит в lifecycle уже проверенный immutable route pin.
// Digest считается по оригинальному файлу закрепления.
func (e execution) recordRouteSelected(visit commandVisit) error {
	a := e.attempt
	hash, at, err := e.request.Store.RoutePinEvidence(a.Task, a.ID)
	if err != nil {
		return err
	}
	selected, err := time.Parse(time.RFC3339, at)
	if err != nil {
		return err
	}
	source := "task_override"
	if a.QueueDispatchID != "" {
		source = "queue_override"
	}
	details := map[string]any{"catalogHash": a.CatalogHash, "routePinSha256": hash,
		"selectedAt": selected.UTC().Format(lifecycleTime), "selectionSource": source}
	return e.appendLife(commandVisit{boot: visit.boot, session: visit.session}, "route_selected", "", details)
}

func (e execution) recordNodeVisit(visit commandVisit, cursor state.StageSnapshot) error {
	reason := "initial"
	var transition any
	if cursor.Sequence > 0 {
		reason, transition = "forward_transition", "tr_"+cursor.HeadEventHash[:32]
	}
	details := map[string]any{"visitReason": reason, "cursorOrdinal": cursor.Sequence,
		"transitionId": transition, "stageEventHash": cursor.HeadEventHash}
	return e.appendLife(visit, "node_visit_started", visit.visitSpan, details)
}

func (e execution) finishCommandVisit(visit commandVisit, verdict string) error {
	var digest any
	if verdict != "" {
		digest = lifecycleDigest(verdict)
	}
	details := map[string]any{
		"status": "succeeded", "reasonCode": "normal", "reasonTextSha256": nil,
		"durationMs": 0, "durationFidelity": "derived", "evidenceSha256": nil,
		"exitCode": 0, "signal": nil, "verdictSha256": digest,
	}
	return e.appendLife(visit, "command_finished", visit.commandSpan, details)
}

// appendLife задаёт scope связанного span и передаёт черновик каноническому writer.
// Данные проекта и токены права в событие не попадают.
func (e execution) appendLife(visit commandVisit, kind, span string, details map[string]any) error {
	event := e.lifeDraft(visit, kind, span, details)
	return e.writeLifeDraft(event)
}

// lifeDraft создаёт общий конверт события с привязкой к визиту и исполнению.
// Состав детали и роль span определяются конкретной операцией.
func (e execution) lifeDraft(visit commandVisit, kind, span string, details map[string]any) map[string]any {
	a := e.attempt
	event := map[string]any{
		"schemaVersion": 1, "protocolVersion": 2, "eventId": lifeID("ev"),
		"taskId": "t" + a.Task, "attemptId": a.ID, "profile": a.Profile,
		"routeId": a.RouteID, "routeHash": a.RouteHash, "orchestratorSessionId": visit.session,
		"at": time.Now().UTC().Format(lifecycleTime), "kind": kind, "writerVersion": "factory-go",
		"nodeVisitId": nil, "nodeExecutionId": nil, "nodeId": nil, "runKey": nil,
		"dispatchId": nil, "runId": nil, "epoch": nil, "spanId": nil,
		"clock":   map[string]any{"bootId": visit.boot, "monotonicNs": "0", "fidelity": "wall"},
		"details": details,
	}
	if visit.visit != "" {
		event["nodeVisitId"], event["nodeId"], event["runKey"] = visit.visit, visit.node, visit.key
	}
	if span != "" {
		event["spanId"] = span
	}
	if kind == "command_started" || kind == "command_finished" || kind == "node_execution_started" {
		event["nodeExecutionId"] = visit.execution
	}
	return event
}

func (e execution) writeLifeDraft(event map[string]any) error {
	a := e.attempt
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = e.request.Store.AppendLifecycle(a.Task, a.ID, raw, 0)
	return err
}

func (visit commandVisit) origin() map[string]any {
	return map[string]any{
		"nodeVisitId": visit.visit, "orchestratorSessionId": visit.session,
		"node": visit.node, "runKey": visit.key, "cursorOrdinal": visit.ordinal,
	}
}

func lifeID(prefix string) string {
	var value [16]byte
	_, _ = rand.Read(value[:])
	return prefix + "_" + hex.EncodeToString(value[:])
}

func lifecycleDigest(value string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(value)))
}
