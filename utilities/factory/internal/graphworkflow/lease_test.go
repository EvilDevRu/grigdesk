package graphworkflow

import "testing"

func TestLeaseAcceptsIndependentCompletionsAndFencesLateWorker(t *testing.T) {
	run := &Snapshot{
		ID: "run",
		Order: []string{"left", "right"},
		Nodes: map[string]*Instance{
			"left": {ID: "left", Generation: 1, Status: "ready"},
			"right": {ID: "right", Generation: 1, Status: "ready"},
		},
	}
	left, err := run.Acquire("left", "left-token", 100)
	if err != nil {
		t.Fatal(err)
	}
	right, err := run.Acquire("right", "right-token", 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := run.Settle(Settlement{RunID: "run", NodeID: "right", Generation: 1,
		ClaimID: right.ClaimID, Rows: []Row{{Key: "b", Title: "Правый", Text: "из правой"}}}, 120); err != nil {
		t.Fatal(err)
	}
	if err := run.Settle(Settlement{RunID: "run", NodeID: "left", Generation: 1,
		ClaimID: left.ClaimID, ErrorCode: "run_failed"}, 130); err != nil {
		t.Fatalf("независимое завершение не должно зависеть от head ревизии: %v", err)
	}
	run.Nodes["left"].Generation++
	run.Nodes["left"].Status = "ready"
	next, err := run.Acquire("left", "next-token", 140)
	if err != nil {
		t.Fatal(err)
	}
	if err := run.Settle(Settlement{
		RunID: "run", NodeID: "left", Generation: 1, ClaimID: left.ClaimID,
		Rows: []Row{{Key: "a", Title: "Старый", Text: "устарел"}},
	}, 150); err == nil {
		t.Fatal("устаревшая выдача принята")
	}
	if next.Generation != 2 || run.Nodes["right"].Rows[0].Text != "из правой" ||
		run.Nodes["left"].Status != "running" {
		t.Fatalf("старый результат затронул новую или независимую ветку: %+v", run.Nodes)
	}
}

func TestLeaseExpiresOnlyRealDeadlines(t *testing.T) {
	run := &Snapshot{
		ID: "run",
		Order: []string{"left"},
		Nodes: map[string]*Instance{
			"left": {ID: "left", Generation: 1, Status: "ready"},
		},
	}
	lease, err := run.Acquire("left", "token", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if run.Expire(1000 + leaseMillis - 1) {
		t.Fatalf("выдача до срока не прерывается")
	}
	if !run.Expire(1000 + leaseMillis) {
		t.Fatalf("выдача по истечении срока прерывается")
	}
	if run.Nodes["left"].Status != "failed" || run.Nodes["left"].ErrorCode != "interrupted" {
		t.Fatalf("истёкшая выдача становится failed/interrupted: %+v", run.Nodes["left"])
	}
	if err := run.Settle(Settlement{RunID: "run", NodeID: "left", Generation: 1, ClaimID: lease.ClaimID,
		Rows: []Row{{Key: "a", Title: "Поздний", Text: "ответ"}}}, 1000+leaseMillis+1); err == nil {
		t.Fatalf("поздний settle истёкшей выдачи отвергается")
	}
}