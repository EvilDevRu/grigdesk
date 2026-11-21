package state

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func TestStageBootstrapAnswerHistorical(t *testing.T) {
	f := seedHistoricalAttempt(t)
	a, err := f.store.ReadAttempt("51", f.active)
	if err != nil {
		t.Fatal(err)
	}
	attempt := filepath.Join(f.store.ControlDir, "protocol-v2", "tasks", "t51", "attempts", f.active)
	installHistoricalFiles(t, "bootstrap.json", filepath.Join(attempt, "bootstrap-results"), f.routes)
	var stop struct {
		VisitID  string `json:"visitId"`
		StopHash string `json:"recordHash"`
	}
	if err := json.Unmarshal(historicalInput(t, "bootstrap-stop.json"), &stop); err != nil {
		t.Fatal(err)
	}
	waiting, err := f.store.BootstrapWaiting(a)
	if err != nil || !waiting {
		t.Fatalf("исторический stop: waiting=%v %v", waiting, err)
	}
	reply := BootstrapDecision{stop.VisitID, stop.StopHash, "Проверить A & B\nСохранить <результат>"}
	if _, replay, err := f.store.AnswerBootstrap(a, reply); err != nil || replay {
		t.Fatalf("первичный ответ: replay=%v, %v", replay, err)
	}
	if _, replay, err := f.store.AnswerBootstrap(a, reply); err != nil || !replay {
		t.Fatalf("дословный повтор: replay=%v, %v", replay, err)
	}
	reply.Answer = "Другой текст"
	if _, _, err := f.store.AnswerBootstrap(a, reply); !errors.Is(err, ErrConflict) {
		t.Fatalf("иной ответ не отклонён: %v", err)
	}
	if _, err := f.store.ReadStage("51", f.active); !errors.Is(err, ErrStageAbsent) {
		t.Fatalf("ответ создал main cursor: %v", err)
	}
	if _, evidence, err := f.store.BeginBootstrap(a); err != nil ||
		objectField(evidence, "question")["recordHash"] != stop.StopHash ||
		objectField(evidence, "decision")["answer"] != "Проверить A & B\nСохранить <результат>" {
		t.Fatalf("новый визит не получил точный исторический вопрос и ответ: %v %v", evidence, err)
	}
}
