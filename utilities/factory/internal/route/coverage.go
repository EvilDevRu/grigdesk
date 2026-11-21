package route

import (
	"slices"
)

type AgentStage struct {
	Node, Key string
}

// AgentStages возвращает точные узлы и ключи нужных цепочек у проверенного бандла.
// Пустой узел означает весь маршрут, иначе обход включает next и rewind всех исходов.
func (b MachineBundle) AgentStages(node string) []AgentStage {
	model := b.model
	pending := []string{node}
	if node == "" {
		pending = slices.Clone(model.orderedIDs)
	}
	visited, stages := make(map[string]bool), make(map[string]string)
	for len(pending) > 0 {
		id := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if visited[id] {
			continue
		}
		visited[id] = true
		item := model.nodes[id]
		if item["executor"] == "agent" {
			stages[id] = textValue(item["runKey"])
		}
		for _, field := range []string{"on", "onFailure"} {
			for _, value := range objectValue(item[field]) {
				action := objectValue(value)
				for _, key := range []string{"next", "rewind"} {
					if target := textValue(action[key]); target != "" {
						pending = append(pending, target)
					}
				}
			}
		}
	}
	result := make([]AgentStage, 0, len(stages))
	for _, id := range sortedKeys(stages) {
		result = append(result, AgentStage{Node: id, Key: stages[id]})
	}
	return result
}
