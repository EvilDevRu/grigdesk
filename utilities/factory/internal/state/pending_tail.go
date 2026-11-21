package state

// stopAction повторяет обязательные поля действия безопасной остановки.
// Эталон допускает ровно rewind (строка) и reset (список), без лишних ключей.
type stopAction struct {
	rewind string
	reset  []string
}

type pendingBase struct {
	sequence      int64
	headEventHash [32]byte
	node          string
	outcome       string
	verdict       [32]byte
	reason        string
}

type pendingState struct {
	sequence      int64
	headEventHash [32]byte
	state         string
	currentNode   string
	stop          string
}

type pendingEvent struct {
	kind              string
	node              string
	outcome           string
	verdict           [32]byte
	reason            string
	action            *stopAction
	previousEventHash [32]byte
	rawHash           [32]byte
}

// classifyPendingTail различает уже записанный точный переход и новое посещение.
// Событие обязано быть следующим за базой и совпадать по узлу, исходу, вердикту,
// предшественнику и хешу сырых байтов; safety-stop дополнительно требует
// остановленный курсор с тем же кодом остановки и непустой reason писателя.
func classifyPendingTail(base pendingBase, state pendingState, event pendingEvent) string {
	if state.sequence != base.sequence+1 {
		return "stale"
	}
	switch event.kind {
	case "commit", "no-progress", "rewind-limit", "loop-ceiling":
	default:
		return "stale"
	}
	if event.node != base.node || event.outcome != base.outcome ||
		event.previousEventHash != base.headEventHash || event.verdict != base.verdict ||
		event.rawHash != state.headEventHash {
		return "stale"
	}
	if event.kind != "commit" {
		if state.state != "stopped" || state.stop != event.kind ||
			event.action == nil || event.reason == "" {
			return "stale"
		}
		return "committed"
	}
	if event.reason != base.reason {
		return "stale"
	}
	return "committed"
}
