package state

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/graphworkflow"
	"grigdesk.local/tools/utilities/factory/internal/host"
)

var errGraphProcessUnconfirmed = errors.New("process_exit_unconfirmed")

// graphReservation — физическое место модельной работы до доказанного выхода.
// Одна резервация на экземпляр с учётом всех поколений до освобождения.
type graphReservation struct {
	ID            string                    `json:"id"`
	NodeID        string                    `json:"nodeId"`
	Generation    uint64                    `json:"generation"`
	ClaimID       string                    `json:"claimId"`
	OwnerNonce    string                    `json:"ownerNonce"`
	OwnerIdentity host.ProcessIdentity      `json:"ownerIdentity"`
	Scope         *host.TreeOwner           `json:"scope,omitempty"`
	BootID        string                    `json:"bootId"`
	ExpiresAt     int64                     `json:"expiresAt"`
	Phase         string                    `json:"phase"`
	CloseKind     string                    `json:"closeKind,omitempty"`
	ClosedAt      int64                     `json:"closedAt,omitempty"`
	Settlement    *graphworkflow.Settlement `json:"settlement,omitempty"`
}

// GraphModelReceipt — квитанция владельцу модельного процесса.
type GraphModelReceipt struct {
	OwnerNonce string `json:"ownerNonce"`
	ExpiresAt  int64  `json:"expiresAt"`
	ClosedAt   int64  `json:"closedAt,omitempty"`
	Revision   uint64 `json:"revision,omitempty"`
}

func graphReservationFor(index *graphActiveIndex, claimID string) *graphReservation {
	if index.Reservations == nil {
		return nil
	}
	return index.Reservations[claimID]
}

func graphReservationOfNode(index *graphActiveIndex, id, nodeID string) *graphReservation {
	for _, reservation := range index.Reservations {
		if reservation.ID == id && reservation.NodeID == nodeID {
			return reservation
		}
	}
	return nil
}

func graphPutReservation(index *graphActiveIndex, reservation *graphReservation) {
	if index.Reservations == nil {
		index.Reservations = map[string]*graphReservation{}
	}
	index.Reservations[reservation.ClaimID] = reservation
}

// ModelOpen фиксирует владельца выдачей до запуска провайдера.
// RPC обязан исходить от самого владельца, захват — из отдельной сессии.
func (s Store) ModelOpen(id, nodeID string, generation uint64, claimID, ownerNonce string,
	ownerPid int, now int64,
) (GraphModelReceipt, error) {
	var receipt GraphModelReceipt
	err := s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		if os.Getppid() != ownerPid {
			return errGraphProcessUnconfirmed
		}
		_, snapshot, err := readGraphRunLocked(root, id)
		if err != nil {
			return graphReadError(err)
		}
		node := snapshot.Nodes[nodeID]
		if node == nil || node.Claim == nil || node.Status != "running" ||
			node.Claim.ClaimID != claimID || node.Claim.Generation != generation || now >= node.Claim.ExpiresAt-60_000 {
			return graphworkflow.ErrStaleClaim
		}
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		if existing := graphReservationFor(&index, claimID); existing != nil {
			if existing.OwnerNonce == ownerNonce && existing.OwnerIdentity.PID == ownerPid &&
				host.StillRunning(existing.OwnerIdentity) {
				receipt = GraphModelReceipt{OwnerNonce: existing.OwnerNonce, ExpiresAt: existing.ExpiresAt}
				return nil
			}
			return graphworkflow.ErrStaleClaim
		}
		if graphReservationOfNode(&index, id, nodeID) != nil {
			return graphworkflow.ErrStaleClaim
		}
		owner, err := host.CaptureTree(ownerPid)
		if err != nil {
			return errGraphProcessUnconfirmed
		}
		boot, err := host.CurrentBootID()
		if err != nil {
			return errGraphProcessUnconfirmed
		}
		reservation := &graphReservation{
			ID: id, NodeID: nodeID, Generation: generation, ClaimID: claimID,
			OwnerNonce: ownerNonce, OwnerIdentity: owner.Leader, BootID: boot,
			ExpiresAt: node.Claim.ExpiresAt, Phase: "opened",
		}
		graphPutReservation(&index, reservation)
		if err := publishGraphActive(root, index); err != nil {
			return err
		}
		receipt = GraphModelReceipt{OwnerNonce: ownerNonce, ExpiresAt: reservation.ExpiresAt}
		return nil
	})
	return receipt, err
}

// ModelAdmit допускает provider только после долговечной записи scope.
// Scope обязан быть дочерней сессией того же владельца и той же загрузки.
func (s Store) ModelAdmit(id, nodeID string, generation uint64, claimID, ownerNonce string,
	scopePid int, now int64,
) (GraphModelReceipt, error) {
	var receipt GraphModelReceipt
	err := s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		reservation := graphReservationFor(&index, claimID)
		if reservation == nil || reservation.ID != id || reservation.NodeID != nodeID ||
			reservation.Generation != generation || reservation.OwnerNonce != ownerNonce ||
			reservation.Phase != "opened" || now >= reservation.ExpiresAt-60_000 {
			return graphworkflow.ErrStaleClaim
		}
		scope, err := host.CaptureTree(scopePid)
		if err != nil {
			return errGraphProcessUnconfirmed
		}
		boot, err := host.CurrentBootID()
		if err != nil || scope.Leader.PPID != reservation.OwnerIdentity.PID ||
			!host.StillRunning(reservation.OwnerIdentity) || boot != reservation.BootID {
			return errGraphProcessUnconfirmed
		}
		reservation.Scope = &scope
		reservation.Phase = "admitted"
		if err := publishGraphActive(root, index); err != nil {
			return err
		}
		receipt = GraphModelReceipt{OwnerNonce: ownerNonce, ExpiresAt: reservation.ExpiresAt}
		return nil
	})
	return receipt, err
}

// ModelStop прекращает подтверждённую группу, не освобождая выдачу.
// Сигналы идут вне блокировки, отказ относится только к этой работе.
func (s Store) ModelStop(id, claimID, ownerNonce string) error {
	var scope host.TreeOwner
	err := s.withGraphWorkflowRoot(false, func(root *os.Root) error {
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		reservation := graphReservationFor(&index, claimID)
		if reservation == nil || reservation.ID != id || reservation.OwnerNonce != ownerNonce ||
			reservation.Phase != "admitted" || reservation.Scope == nil {
			return graphworkflow.ErrStaleClaim
		}
		scope = *reservation.Scope
		return nil
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := host.StopTree(ctx, scope, 5*time.Second); err != nil {
		return errGraphProcessUnconfirmed
	}
	return nil
}

// ModelClose принимает квитанцию выхода и завершает работу двумя публикациями.
// Сначала долговечная квитанция в индексе, затем снимок; обрыв дочитывает reconcile.
func (s Store) ModelClose(id, nodeID string, generation uint64, claimID, ownerNonce, closeKind string,
	settlement *graphworkflow.Settlement, now int64,
) (GraphModelReceipt, error) {
	var receipt GraphModelReceipt
	err := s.withGraphWorkflowRoot(true, func(root *os.Root) error {
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		reservation := graphReservationFor(&index, claimID)
		if reservation == nil || reservation.ID != id || reservation.NodeID != nodeID ||
			reservation.Generation != generation || reservation.OwnerNonce != ownerNonce {
			return graphworkflow.ErrStaleClaim
		}
		if reservation.Phase == "closing" {
			receipt = GraphModelReceipt{
				OwnerNonce: ownerNonce, ExpiresAt: reservation.ExpiresAt, ClosedAt: reservation.ClosedAt,
			}
			return s.completeGraphClose(root, &index, reservation, now, &receipt)
		}
		switch closeKind {
		case "never_spawned":
			if reservation.Phase != "opened" {
				return graphworkflow.ErrStaleClaim
			}
			if settlement != nil && settlement.ErrorCode == "" {
				settlement = &graphworkflow.Settlement{ErrorCode: "run_failed"}
			}
		case "scope_exit":
			if reservation.Phase != "admitted" || reservation.Scope == nil {
				return graphworkflow.ErrStaleClaim
			}
			exited, err := host.TreeExitConfirmed(*reservation.Scope)
			if err != nil || !exited {
				return errGraphProcessUnconfirmed
			}
		default:
			return fmt.Errorf("closeKind: неизвестный вид закрытия")
		}
		final := graphworkflow.Settlement{
			RunID: id, NodeID: nodeID, Generation: generation, ClaimID: claimID, ErrorCode: "interrupted",
		}
		if now < reservation.ExpiresAt-60_000 && settlement != nil {
			final = *settlement
			final.RunID = id
			final.NodeID = nodeID
			final.Generation = generation
			final.ClaimID = claimID
			if err := graphValidateSettlement(final); err != nil {
				return err
			}
		}
		reservation.Phase = "closing"
		reservation.CloseKind = closeKind
		reservation.ClosedAt = now
		reservation.Settlement = &final
		if err := publishGraphActive(root, index); err != nil {
			return err
		}
		receipt = GraphModelReceipt{OwnerNonce: ownerNonce, ExpiresAt: reservation.ExpiresAt, ClosedAt: now}
		return s.completeGraphClose(root, &index, reservation, now, &receipt)
	})
	return receipt, err
}

// completeGraphClose публикует снимок после квитанции и снимает резервацию.
// Повтор с тем же токеном пропускает уже записанное событие.
func (s Store) completeGraphClose(root *os.Root, index *graphActiveIndex,
	reservation *graphReservation, now int64, receipt *GraphModelReceipt,
) error {
	envelope, snapshot, err := readGraphRunLocked(root, reservation.ID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			delete(index.Reservations, reservation.ClaimID)
			return publishGraphActive(root, *index)
		}
		index.FaultUntil = now + graphFaultHorizon
		delete(index.Reservations, reservation.ClaimID)
		return publishGraphActive(root, *index)
	}
	node := snapshot.Nodes[reservation.NodeID]
	committed := node != nil && node.Generation == reservation.Generation &&
		node.Claim == nil && (node.Status == "done" || node.Status == "failed")
	if committed {
		receipt.Revision = envelope.Revision
	}
	if !committed && node != nil && node.Generation == reservation.Generation {
		if err := graphValidateSources(snapshot, node, reservation.Settlement.Rows); err != nil {
			reservation.Settlement.ErrorCode = "bad_model_result"
			reservation.Settlement.Rows = nil
		}
		if err := snapshot.Settle(*reservation.Settlement, reservation.ClosedAt); err != nil {
			node.Claim = nil
			node.Status = "failed"
			node.ErrorCode = "interrupted"
			snapshot.Clock++
			snapshot.Events = append(snapshot.Events, graphworkflow.Event{
				At: snapshot.Clock, Kind: "settle", NodeID: node.ID,
				Generation: node.Generation, ErrorCode: "interrupted",
			})
		}
		if err := snapshot.Advance(); err != nil {
			return err
		}
		if err := s.publishGraphRunLocked(root, reservation.ID, &envelope, snapshot); err != nil {
			return err
		}
		receipt.Revision = envelope.Revision
	}
	delete(index.Reservations, reservation.ClaimID)
	return publishGraphActive(root, *index)
}

func graphReadError(err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return ErrGraphNotFound
	}
	return ErrGraphBroken
}

// reconcileGraphReservations освобождает места только по доказанному выходу.
// Новая загрузка освобождает прежние слоты, неизвестный probe удерживает место.
func (s Store) reconcileGraphReservations(root *os.Root, index *graphActiveIndex, now int64,
	changed *[]GraphUpdate,
) error {
	if len(index.Reservations) == 0 {
		return nil
	}
	boot, bootErr := host.CurrentBootID()
	for _, reservation := range index.Reservations {
		if reservation.Phase != "closing" && bootErr == nil && reservation.BootID != boot {
			if err := s.retireGraphReservation(root, index, reservation, now, changed); err != nil {
				return err
			}
			continue
		}
		switch reservation.Phase {
		case "closing":
			receipt := GraphModelReceipt{OwnerNonce: reservation.OwnerNonce, ExpiresAt: reservation.ExpiresAt, ClosedAt: reservation.ClosedAt}
			if err := s.completeGraphClose(root, index, reservation, now, &receipt); err != nil {
				return err
			}
			if receipt.Revision > 0 {
				*changed = append(*changed, GraphUpdate{ID: reservation.ID, Revision: receipt.Revision})
			}
		case "opened":
			if !host.StillRunning(reservation.OwnerIdentity) {
				if err := s.retireGraphReservation(root, index, reservation, now, changed); err != nil {
					return err
				}
			}
		case "admitted":
			if reservation.Scope == nil || host.StillRunning(reservation.OwnerIdentity) {
				continue
			}
			exited, err := host.TreeExitConfirmed(*reservation.Scope)
			if err == nil && exited {
				if err := s.retireGraphReservation(root, index, reservation, now, changed); err != nil {
					return err
				}
			}
		}
	}
	return publishGraphActive(root, *index)
}

// retireGraphReservation завершает работу прерванной выдачей и снимает место.
func (s Store) retireGraphReservation(root *os.Root, index *graphActiveIndex,
	reservation *graphReservation, now int64, changed *[]GraphUpdate,
) error {
	envelope, snapshot, err := readGraphRunLocked(root, reservation.ID)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			index.FaultUntil = now + graphFaultHorizon
		}
		delete(index.Reservations, reservation.ClaimID)
		return nil
	}
	node := snapshot.Nodes[reservation.NodeID]
	if node != nil && node.Generation == reservation.Generation && node.Claim != nil &&
		node.Claim.ClaimID == reservation.ClaimID {
		node.Claim = nil
		node.Status = "failed"
		node.ErrorCode = "interrupted"
		snapshot.Clock++
		snapshot.Events = append(snapshot.Events, graphworkflow.Event{
			At: snapshot.Clock, Kind: "expire", NodeID: node.ID,
			Generation: node.Generation, ErrorCode: "interrupted",
		})
		if err := snapshot.Advance(); err != nil {
			return err
		}
		if err := s.publishGraphRunLocked(root, reservation.ID, &envelope, snapshot); err != nil {
			return err
		}
		*changed = append(*changed, GraphUpdate{ID: reservation.ID, Revision: envelope.Revision})
	}
	delete(index.Reservations, reservation.ClaimID)
	return nil
}
