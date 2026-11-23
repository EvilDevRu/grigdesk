package graphworkflow

import (
	"fmt"
	"strings"
)

// Retry повторяет только завершившийся отказом экземпляр с новой generation.
// Blocked-зависимые возвращаются в работу, принятые fast-join результаты сохраняются.
func (run *Snapshot) Retry(id string) error {
	node := run.Nodes[id]
	if node == nil || node.Status != "failed" {
		return fmt.Errorf("retry: повтор доступен только завершившемуся отказом экземпляру")
	}
	if isGroupKind(node.Kind) {
		run.removeSubtree(node)
		node.Members = nil
		node.ActiveItems = nil
		node.Rounded = 0
	}
	run.Generations[id]++
	node.Generation = run.Generations[id]
	node.Status = "pending"
	node.Selected = nil
	node.DataRefs = nil
	node.Rows = nil
	node.Claim = nil
	node.ErrorCode = ""
	node.AcceptedAt = 0
	run.Events = append(run.Events, Event{At: run.Clock, Kind: "retry", NodeID: id, Generation: node.Generation})
	run.reopenBlockedDependents(id)
	return nil
}

// removeSubtree снимает детей группы из текущих nodes, сохраняя максимумы поколений.
// История прежних экземпляров остаётся в событиях, текущие ID не дублируются.
func (run *Snapshot) removeSubtree(node *Instance) {
	prefix := node.ID + "."
	kept := run.Order[:0]
	for _, id := range run.Order {
		member := run.Nodes[id]
		if member != nil && strings.HasPrefix(member.ID, prefix) {
			run.Events = append(run.Events, Event{
				At: run.Clock, Kind: "revoke", NodeID: member.ID, Generation: member.Generation,
				ErrorCode: member.Status,
			})
			delete(run.Nodes, member.ID)
			continue
		}
		kept = append(kept, id)
	}
	run.Order = kept
}

// reopenBlockedDependents возвращает blocked-зависимые и группы к пересчёту.
// Группа с живыми детьми снова агрегируется, пустая — материализуется заново.
func (run *Snapshot) reopenBlockedDependents(id string) {
	closure := map[string]bool{id: true}
	for changed := true; changed; {
		changed = false
		for _, node := range run.Nodes {
			if closure[node.ID] {
				continue
			}
			decl := run.declOf(node)
			for _, need := range decl.Needs {
				if closure[node.Prefix+need] {
					closure[node.ID] = true
					changed = true
					break
				}
			}
			if !closure[node.ID] && node.Parent != "" && closure[node.Parent] {
				closure[node.ID] = true
				changed = true
			}
		}
		for member := range closure {
			node := run.Nodes[member]
			for node != nil && node.Parent != "" {
				parent := run.Nodes[node.Parent]
				if parent == nil {
					break
				}
				if !closure[parent.ID] {
					closure[parent.ID] = true
					changed = true
				}
				node = parent
			}
		}
	}
	for _, node := range run.Nodes {
		if node.ID == id || !closure[node.ID] || node.Status != "blocked" {
			continue
		}
		if isGroupKind(node.Kind) {
			if len(node.Members) > 0 {
				node.Status = "running"
				node.ErrorCode = ""
			} else {
				node.Status = "pending"
				node.ErrorCode = ""
				node.Selected = nil
				node.DataRefs = nil
			}
			continue
		}
		run.Generations[node.ID]++
		node.Generation = run.Generations[node.ID]
		node.Status = "pending"
		node.Selected = nil
		node.DataRefs = nil
		node.ErrorCode = ""
		node.AcceptedAt = 0
	}
}

// dependentLocals собирает замыкание зависимых объявлений внутри одной области.
// Возврат с ворот пересчитывает только это замыкание и саму вершину утверждения.
func dependentLocals(scope Scope, target string, extra ...string) map[string]bool {
	closure := map[string]bool{target: true}
	for _, id := range extra {
		closure[id] = true
	}
	for changed := true; changed; {
		changed = false
		for _, step := range scope.Steps {
			if closure[step.ID] {
				continue
			}
			for _, need := range step.Needs {
				if closure[need] {
					closure[step.ID] = true
					changed = true
					break
				}
			}
		}
	}
	return closure
}

// Decide принимает решение ожидающих ворот с точным поколением.
// Отказ с целью пересоздаёт зависимую часть области, сохраняя независимые выходы.
func (run *Snapshot) Decide(nodeID string, generation uint64, approve bool, target, comment string) error {
	node := run.Nodes[nodeID]
	if node == nil || node.Kind != "approval" || node.Status != "waiting" || node.Generation != generation {
		return fmt.Errorf("decide: ворота не ожидают решения в этом поколении")
	}
	decl := run.declOf(node)
	if approve {
		// Снимки прежней версии могли оставить слишком большие ворота в ожидании.
		if _, err := run.RowsFor(ResultRef{ID: nodeID, Generation: generation}, ReviewOutputLimit); err != nil {
			return err
		}
		yes := true
		run.Events = append(run.Events, Event{
			At: run.Clock + 1, Kind: "decision", NodeID: nodeID, Generation: generation,
			Approve: &yes, Selected: node.Selected,
		})
		run.acceptLeaf(node)
		return nil
	}
	if strings.TrimSpace(comment) == "" {
		return fmt.Errorf("comment: отказ требует замечания")
	}
	no := false
	if len(decl.RetryFrom) == 0 {
		run.Events = append(run.Events, Event{
			At: run.Clock, Kind: "decision", NodeID: nodeID, Generation: generation,
			Approve: &no, Comment: comment,
		})
		run.Rejected = true
		for _, member := range run.Nodes {
			if member.ID != nodeID && (member.Status == "ready" || member.Status == "pending" || member.Status == "waiting") {
				member.Status = "blocked"
			}
		}
		node.Status = "failed"
		node.ErrorCode = "rejected"
		return nil
	}
	local := ""
	for _, candidate := range decl.RetryFrom {
		if node.Prefix+candidate == target || (target == "" && len(decl.RetryFrom) == 1) {
			local = candidate
			break
		}
	}
	if local == "" {
		return fmt.Errorf("target: цель возврата не объявлена воротами")
	}
	scope := run.Definition.Scope
	if node.Parent != "" {
		scope = *run.declOf(run.Nodes[node.Parent]).Scope
	}
	closure := dependentLocals(scope, local, node.LocalID)
	affected := make([]*Instance, 0)
	for _, id := range run.Order {
		member := run.Nodes[id]
		if member == nil || member.Prefix != node.Prefix || !closure[member.LocalID] {
			continue
		}
		affected = append(affected, member)
		if isGroupKind(member.Kind) {
			prefix := member.ID + "."
			for _, childID := range run.Order {
				child := run.Nodes[childID]
				if child != nil && strings.HasPrefix(child.ID, prefix) {
					affected = append(affected, child)
				}
			}
		}
	}
	for _, member := range affected {
		if member.Claim != nil {
			return fmt.Errorf("retryFrom: живая выдача в пересчитываемой части")
		}
	}
	run.Events = append(run.Events, Event{
		At: run.Clock, Kind: "decision", NodeID: nodeID, Generation: generation,
		Approve: &no, Target: node.Prefix + local, Comment: comment,
	})
	argumentRefs := node.ArgumentRefs
	scopeItem := node.ItemRef
	for _, member := range affected {
		run.Events = append(run.Events, Event{
			At: run.Clock, Kind: "revoke", NodeID: member.ID, Generation: member.Generation,
			ErrorCode: member.Status,
		})
		delete(run.Nodes, member.ID)
	}
	kept := run.Order[:0]
	removed := map[string]bool{}
	for _, member := range affected {
		removed[member.ID] = true
	}
	for _, id := range run.Order {
		if !removed[id] {
			kept = append(kept, id)
		}
	}
	run.Order = kept
	for _, step := range scope.Steps {
		if !closure[step.ID] {
			continue
		}
		run.makeInstance(node.Prefix, node.Parent, step, argumentRefs, scopeItem, comment)
	}
	return nil
}

// ReviewTarget — объявленная цель возврата с точным ID экземпляра области.
type ReviewTarget struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	DeliversFeedback bool   `json:"deliversFeedback"`
}

// ReviewTargets описывает действия ворот для UI без права дописывать новые ветки.
// deliversFeedback истинно при модельном шаге в пересчитываемом подграфе.
func (run *Snapshot) ReviewTargets(node *Instance) []ReviewTarget {
	decl := run.declOf(node)
	scope := run.Definition.Scope
	if node.Parent != "" {
		scope = *run.declOf(run.Nodes[node.Parent]).Scope
	}
	targets := make([]ReviewTarget, 0, len(decl.RetryFrom))
	for _, local := range decl.RetryFrom {
		var step Step
		for _, candidate := range scope.Steps {
			if candidate.ID == local {
				step = candidate
				break
			}
		}
		closure := dependentLocals(scope, local)
		targets = append(targets, ReviewTarget{
			ID: node.Prefix + local, Title: step.Title, DeliversFeedback: closureHasModel(scope, closure),
		})
	}
	return targets
}

func closureHasModel(scope Scope, closure map[string]bool) bool {
	for _, step := range scope.Steps {
		if !closure[step.ID] {
			continue
		}
		if isModelKind(step.Kind) {
			return true
		}
		if step.Scope != nil && scopeHasModel(*step.Scope) {
			return true
		}
	}
	return false
}

func scopeHasModel(scope Scope) bool {
	for _, step := range scope.Steps {
		if isModelKind(step.Kind) {
			return true
		}
		if step.Scope != nil && scopeHasModel(*step.Scope) {
			return true
		}
	}
	return false
}

// RequiresModel проверяет также объявления вложенных областей.
// Платформа проверяется до создания снимка или запуска исполнителя.
func (def Definition) RequiresModel() bool {
	return scopeHasModel(def.Scope)
}
