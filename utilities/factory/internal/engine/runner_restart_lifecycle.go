package engine

import (
	"encoding/json"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

// restartLifecycle привязывает переходы к уже записанному визиту и точному запуску.
// Стабильный eventId и время приёма позволяют подтвердить повтор до отмены дерева.
func (e execution) restartLifecycle(
	visit commandVisit,
) func(state.RunIdentity, state.StageRunnerRestart, bool) error {
	dispatch := lifeID("d")
	return func(id state.RunIdentity, restart state.StageRunnerRestart, consumed bool) error {
		raw, err := json.Marshal(restart)
		if err != nil {
			return err
		}
		digest := lifecycleDigest(string(raw))
		details := map[string]any{
			"requestId": "rs_" + lifecycleDigest(restart.RequestID)[:32], "sourceRunId": id.ID,
			"sourceEpoch": id.Epoch, "targetProvider": restart.Primary, "requestRecordSha256": digest,
		}
		kind, at := "runner_switch_requested", restart.At
		if consumed {
			kind, at = "runner_switch_consumed", time.Now().UTC().Format(lifecycleTime)
			details["consumeEvidenceSha256"] = lifecycleDigest("owned-tree-closed:" + digest)
		}
		event := e.lifeDraft(visit, kind, "", details)
		event["eventId"] = "ev_" + lifecycleDigest(kind + ":" + id.Attempt + ":" + digest)[:32]
		event["at"], event["dispatchId"], event["nodeExecutionId"] = at, dispatch, visit.execution
		event["runId"], event["epoch"] = id.ID, id.Epoch
		return e.writeLifeDraft(event)
	}
}
