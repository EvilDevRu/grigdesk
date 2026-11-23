package graphworkflow

import (
	"errors"
	"fmt"
	"time"
)

const leaseMillis = int64((6 * time.Minute) / time.Millisecond)

var ErrStaleClaim = errors.New("stale_claim")

// Lease закрепляет выдачу за экземпляром точным токеном и сроком.
// Общая ревизия снимка не участвует в пригодности результата.
type Lease struct {
	ClaimID    string `json:"claimId"`
	Generation uint64 `json:"generation"`
	ExpiresAt  int64  `json:"expiresAt"`
}

type Settlement struct {
	RunID      string `json:"id"`
	NodeID     string `json:"nodeId"`
	Generation uint64 `json:"generation"`
	ClaimID    string `json:"claimId"`
	Rows       []Row  `json:"rows"`
	ErrorCode  string `json:"errorCode,omitempty"`
}

// Acquire закрепляет готовый инстанс за конкретной выдачей.
// Готовность включает допуск по расписанию, выставленный под общей блокировкой.
func (run *Snapshot) Acquire(id, token string, now int64) (Lease, error) {
	node := run.Nodes[id]
	if node == nil || node.Status != "ready" || run.Paused || run.Rejected || token == "" {
		return Lease{}, ErrStaleClaim
	}
	lease := Lease{ClaimID: token, Generation: node.Generation, ExpiresAt: now + leaseMillis}
	node.Status = "running"
	node.Claim = &lease
	return lease, nil
}

// Settle проверяет точную выдачу и завершает только её.
// Владение другим экземпляром не меняет пригодность этого результата.
func (run *Snapshot) Settle(result Settlement, now int64) error {
	node := run.Nodes[result.NodeID]
	if run.ID != result.RunID || node == nil || node.Claim == nil || node.Status != "running" {
		return ErrStaleClaim
	}
	lease := node.Claim
	if lease.Generation != result.Generation || lease.ClaimID != result.ClaimID || now >= lease.ExpiresAt {
		return ErrStaleClaim
	}
	if result.ErrorCode != "" && len(result.Rows) > 0 {
		return fmt.Errorf("settle: отказ не может содержать выход")
	}
	node.Claim = nil
	run.Clock++
	if result.ErrorCode != "" {
		node.ErrorCode = result.ErrorCode
		node.Status = "failed"
		run.Events = append(run.Events, Event{
			At: run.Clock, Kind: "settle", NodeID: node.ID, Generation: node.Generation, ErrorCode: result.ErrorCode,
		})
		return nil
	}
	node.Rows = result.Rows
	node.AcceptedAt = run.Clock
	node.Status = "done"
	node.Feedback = ""
	run.Events = append(run.Events, Event{
		At: run.Clock, Kind: "settle", NodeID: node.ID, Generation: node.Generation,
	})
	return nil
}

// Expire завершает выдачи, чей срок действительно кончился.
// Повтор после этого создаёт новое поколение, прежний ответ не принадлежит ему.
func (run *Snapshot) Expire(now int64) bool {
	return run.ExpireExcept(now, nil)
}

// ExpireExcept оставляет физически зарезервированные выдачи владельцу.
// Для них завершение подтверждает протокол помощника и восстановления.
func (run *Snapshot) ExpireExcept(now int64, reserved func(string) bool) bool {
	changed := false
	for _, id := range run.Order {
		node := run.Nodes[id]
		if node.Claim == nil || now < node.Claim.ExpiresAt ||
			(reserved != nil && reserved(node.Claim.ClaimID)) {
			continue
		}
		node.Claim = nil
		node.Status = "failed"
		node.ErrorCode = "interrupted"
		run.Clock++
		run.Events = append(run.Events, Event{
			At: run.Clock, Kind: "expire", NodeID: node.ID, Generation: node.Generation, ErrorCode: "interrupted",
		})
		changed = true
	}
	return changed
}
