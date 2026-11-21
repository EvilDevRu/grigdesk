package state

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

type BootstrapRun struct {
	Run    RunIdentity
	Result string
}

// BeginBootstrap открывает визит до вызова провайдера.
// Единственный действующий ответ возвращается с исходным вопросом.
func (s Store) BeginBootstrap(a Attempt) (string, map[string]any, error) {
	var evidence record
	var nonce [16]byte
	_, _ = rand.Read(nonce[:])
	id := "b_" + hex.EncodeToString(nonce[:])
	err := s.editBootstrap(a, true, func(_ *taskState, l bootstrapLedger, dir *os.Root) error {
		if l.completed || (l.stop != "" && l.decision == "") {
			return fmt.Errorf("%w: визит разведки не разрешён", ErrConflict)
		}
		if l.decision != "" {
			var question, answer record
			for i := len(l.events) - 1; i >= 0; i-- {
				row := l.events[i]
				if answer == nil && row["kind"] == "decision" {
					answer = bootstrapEvidence(row, l.decision)
				}
				if row["kind"] == "stop" && answer != nil {
					question = bootstrapEvidence(row, stringField(answer, "stopHash"))
					break
				}
			}
			evidence = record{"phase": "bootstrap", "node": "scout", "question": question, "decision": answer}
		}
		return l.append(dir, "visit", id, record{"decisionHash": nilIfEmpty(l.decision)})
	})
	return id, evidence, err
}

func bootstrapEvidence(event record, hash string) record {
	result := record{"recordHash": hash}
	for key, value := range event {
		result[key] = value
	}
	return result
}

// StopBootstrap сохраняет вопрос без основного cursor.
// В журнал попадают только фактически запущенные SCOUT epoch.
func (s Store) StopBootstrap(
	a Attempt, visit, outcome, reason, verdict string, runs []BootstrapRun,
) error {
	rows := make([]any, 0, len(runs))
	for _, item := range runs {
		id := item.Run
		if !id.Valid() || id.Task != a.Task || id.Attempt != a.ID || id.Stage != "SCOUT" {
			return fmt.Errorf("bootstrap: запуск не принадлежит разведке")
		}
		rows = append(rows, record{"runId": id.ID, "epoch": id.Epoch, "result": nilIfEmpty(item.Result)})
	}
	parsed, err := ParseRunVerdict(outcome, verdict)
	if err != nil {
		return err
	}
	var value any
	if parsed != nil {
		value = parsed
	}
	return s.editBootstrap(a, false, func(_ *taskState, l bootstrapLedger, dir *os.Root) error {
		if dir == nil || l.visit != visit || l.stop != "" || l.completed {
			return fmt.Errorf("%w: визит разведки изменился", ErrConflict)
		}
		transition, err := l.stopTransition(outcome, value)
		if err != nil {
			return err
		}
		if !bootstrapText(reason) {
			reason = fmt.Sprintf("SCOUT: исход %s требует решения человека", outcome)
		}
		event := record{"outcome": outcome, "reason": reason, "verdict": value,
			"runs": rows, "transitionHash": transition}
		raw, err := bootstrapJSON(event)
		if err != nil {
			return err
		}
		canonical, err := decodeRecord(raw)
		if err != nil {
			return err
		}
		if err := l.verifyStop(canonical); err != nil {
			return err
		}
		return l.append(dir, "stop", visit, event)
	})
}

// CompleteBootstrap закрывает визит уже опубликованным checkpoint.
// После сбоя между записями resume достраивает только запись completed.
func (s Store) CompleteBootstrap(a Attempt, checkpoint []byte) error {
	return s.editBootstrap(a, false, func(t *taskState, l bootstrapLedger, dir *os.Root) error {
		if l.stop != "" {
			return fmt.Errorf("%w: checkpoint противоречит вопросу разведки", ErrConflict)
		}
		if l.completed || l.visit == "" {
			return nil
		}
		name := filepath.Join("attempts", a.ID, "artifacts", "bootstrap.json")
		raw, err := readTrusted(t.root, name, 1024*1024, immutableMode)
		if err != nil || !bytes.Equal(raw, checkpoint) {
			return fmt.Errorf("%w: checkpoint разведки изменился", ErrConflict)
		}
		return l.append(dir, "completed", l.visit, record{"checkpointHash": digestOf(checkpoint)})
	})
}

// editBootstrap сериализует writers с ответами человека и проверяет активную попытку.
// Создание журнала разрешено только при допуске нового визита.
func (s Store) editBootstrap(
	a Attempt, create bool, action func(*taskState, bootstrapLedger, *os.Root) error,
) error {
	t, err := s.openTask(a.Task, true)
	if err != nil {
		return err
	}
	defer t.close()
	actual, err := t.readAttempt(a.Task, a.ID)
	if err != nil {
		return err
	}
	active, err := t.activeAttempt(a.Task)
	if err != nil || active != a.ID || actual != a || a.Terminal != "" {
		return fmt.Errorf("%w: попытка разведки изменилась", ErrConflict)
	}
	if create {
		name := filepath.Join("attempts", a.ID, "bootstrap-results")
		if err := ensurePrivateDirectory(t.root, name, true); err != nil {
			return err
		}
	}
	ledger, dir, err := t.loadBootstrap(a)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return err
	}
	return action(t, ledger, dir)
}
