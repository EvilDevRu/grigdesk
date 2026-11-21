package state

import "errors"

type pendingCursor struct {
	sequence int64
	head     [32]byte
	node     string
	state    string
}

// classifyPendingAtBase различает исходный узел и более позднюю часть журнала.
// Совпадение позиции ещё требует проверки снимка рабочего дерева.
func classifyPendingAtBase(
	base, current pendingCursor, expectedTree [32]byte, tree *[32]byte,
) (bool, string, error) {
	if current.sequence < base.sequence {
		return false, "", errors.New("номер события уменьшился")
	}
	if current.sequence != base.sequence || current.head != base.head {
		return false, "", nil
	}
	if current.state != "ready" || current.node != base.node {
		return false, "", errors.New("исходный курсор указывает на иное состояние узла")
	}
	if tree == nil {
		return true, "needs-tree", nil
	}
	if *tree != expectedTree {
		return true, "stale", nil
	}
	return true, "ready", nil
}
