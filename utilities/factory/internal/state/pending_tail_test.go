package state

import (
	"crypto/sha256"
	"testing"
)

func TestPendingTail(t *testing.T) {
	base := pendingBase{sequence: 4, node: "review", outcome: "done", reason: "принято"}
	base.headEventHash = sha256.Sum256([]byte("event-4\n"))
	ready := pendingState{sequence: 5, state: "ready", currentNode: "gate_plan"}
	ready.headEventHash = sha256.Sum256([]byte("commit-raw\n"))
	commit := pendingEvent{kind: "commit", node: "review", outcome: "done", reason: "принято"}
	commit.previousEventHash = base.headEventHash
	commit.rawHash = ready.headEventHash
	stop := commit
	stop.kind = "no-progress"
	stop.reason = "автоматический возврат остановлен без прогресса: повтор"
	stop.action = &stopAction{rewind: "instrument", reset: []string{"check"}}
	stopped := ready
	stopped.state = "stopped"
	stopped.stop = "no-progress"
	substituted := stop
	substituted.kind = "commit"
	cases := []struct {
		name  string
		state pendingState
		event pendingEvent
		want  string
	}{
		{"exact-commit", ready, commit, "committed"},
		{"changed-reason", ready, replaceReason(commit, "иная причина"), "stale"},
		{"changed-outcome", ready, replaceOutcome(commit, "failed"), "stale"},
		{"changed-verdict", ready, replaceVerdict(commit, sha256.Sum256([]byte("v2\n"))), "stale"},
		{"changed-previous", ready, replacePrevious(commit, sha256.Sum256([]byte("x\n"))), "stale"},
		{"safety-stop", stopped, stop, "committed"},
		{"safety-stop-running", ready, stop, "stale"},
		{"safety-stop-empty-reason", stopped, replaceReason(stop, ""), "stale"},
		{"kind-substitution", stopped, substituted, "stale"},
		{"human-rewind", ready, replaceKind(commit, "human-rewind"), "stale"},
		{"advanced-two", replaceSequence(ready, 6), commit, "stale"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyPendingTail(base, tc.state, tc.event); got != tc.want {
				t.Fatalf("classifyPendingTail=%q, ожидалось %q", got, tc.want)
			}
		})
	}
}

func replaceReason(e pendingEvent, value string) pendingEvent {
	e.reason = value
	return e
}

func replaceOutcome(e pendingEvent, value string) pendingEvent {
	e.outcome = value
	return e
}

func replaceVerdict(e pendingEvent, value [32]byte) pendingEvent {
	e.verdict = value
	return e
}

func replacePrevious(e pendingEvent, value [32]byte) pendingEvent {
	e.previousEventHash = value
	return e
}

func replaceKind(e pendingEvent, value string) pendingEvent {
	e.kind = value
	return e
}

func replaceSequence(s pendingState, value int64) pendingState {
	s.sequence = value
	return s
}
