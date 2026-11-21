package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type FindingsReport struct {
	Task, Profile, Attempt         string
	BootstrapHash, StageLedgerHash *string
	Findings                       map[string]any
}

// JSON возвращает поля через объект для прежнего лексикографического порядка ключей.
func (r FindingsReport) JSON() map[string]any {
	return map[string]any{
		"schema": 1, "taskId": r.Task, "profile": r.Profile, "attemptId": r.Attempt,
		"bootstrapHash": r.BootstrapHash, "stageLedgerHash": r.StageLedgerHash, "findings": r.Findings,
	}
}

// ReadFindings вычисляет полный route ledger из immutable событий exact попытки.
// Bootstrap проверяется общим валидатором движка, прежде чем смешивать источники.
func (s Store) ReadFindings(task, id, profile, routes string) (FindingsReport, Attempt, []byte, error) {
	var report FindingsReport
	if !attemptPattern.MatchString(id) {
		return report, Attempt{}, nil, fmt.Errorf("findings-export: нужна точная попытка")
	}
	t, err := s.openTask(task, false)
	if err != nil {
		return report, Attempt{}, nil, err
	}
	defer t.close()
	a, err := t.readAttempt(task, id)
	if err != nil {
		return report, a, nil, err
	}
	if profile != a.Profile || routes != a.RoutesDir || a.RouteID == "" {
		return report, a, nil, fmt.Errorf("%w: identity findings-export", ErrConflict)
	}
	ledger, dir, err := t.loadStage(task, id, false)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) && !errors.Is(err, ErrStageAbsent) {
		return report, a, nil, err
	}
	report = FindingsReport{Task: task, Profile: profile, Attempt: id, Findings: ledger.findings()}
	if n := len(ledger.events); n > 0 {
		head := ledger.events[n-1].Hash
		report.StageLedgerHash = &head
	}
	file := filepath.Join("attempts", a.ID, "artifacts", "bootstrap.json")
	raw, err := readTrusted(t.root, file, metadataBytes, immutableMode)
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	} else if err == nil {
		hash := digestOf(raw)
		report.BootstrapHash = &hash
	}
	return report, a, raw, err
}

func (l stageLedger) findings() map[string]any {
	findings := make(map[string]record)
	pair := objectField(l.bundle.Machine, "loop")
	lead, worker := stringField(pair, "lead"), stringField(pair, "worker")
	for _, item := range l.events {
		updateFindings(findings, item.Data, lead, worker)
	}
	projection := map[string]any{"schema": 1}
	groups := map[string][]record{"open": {}, "closed": {}, "deferred": {}}
	var keys []string
	for key := range findings {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	for _, key := range keys {
		row := findings[key]
		status := stringField(row, "status")
		groups[status] = append(groups[status], row)
	}
	for status, rows := range groups {
		projection[status] = rows
	}
	return projection
}

func updateFindings(findings map[string]record, event record, lead, worker string) {
	kind := stringField(event, "kind")
	if !slices.Contains([]string{"commit", "rewind-limit", "no-progress", "loop-ceiling", "loop-continue"},
		kind) {
		return
	}
	node, outcome := stringField(event, "node"), stringField(event, "outcome")
	sequence := integerField(event, "sequence")
	verdict := objectField(event, "verdict")
	if lead != "" && node == lead && successfulLead(event, kind, worker, outcome) {
		closeFindings(findings, worker, sequence, nil)
	}
	switch {
	case outcome == "done":
		closeFindings(findings, node, sequence, nil)
	case outcome == "failed" && verdict != nil:
		closeFindings(findings, node, sequence, blockingFindings(verdict))
	default:
		return
	}
	for _, item := range arrayField(verdict, "findings") {
		finding, _ := item.(record)
		status := "open"
		if outcome == "done" || finding["severity"] == "deferred" {
			status = "deferred"
		}
		id := stringField(finding, "id")
		key := node + "\x00" + id
		row := findings[key]
		if row == nil || row["status"] == "closed" {
			row = record{"id": id, "sourceNode": node, "openedSequence": sequence, "closedSequence": nil}
		}
		row["owner"], row["summary"] = verdict["owner"], finding["summary"]
		row["lastSeenSequence"], row["status"] = sequence, status
		findings[key] = row
	}
}

func successfulLead(event record, kind, worker, outcome string) bool {
	return kind == "loop-continue" || (kind == "commit" && (outcome == "done" ||
		(stringField(objectField(event, "action"), "rewind") == worker &&
			stringField(objectField(event, "after"), "state") == "ready")))
}

func closeFindings(findings map[string]record, node string, sequence int64, keep map[string]bool) {
	for _, row := range findings {
		if row["sourceNode"] == node && row["status"] == "open" && !keep[stringField(row, "id")] {
			row["status"], row["closedSequence"] = "closed", sequence
		}
	}
}

// AppendBootstrapFindings вызывается после проверки точного checkpoint по pin.
// Sequence main ledger сохраняет значение только для находок маршрута.
func (r *FindingsReport) AppendBootstrapFindings(raw []byte) error {
	if len(raw) == 0 || r.BootstrapHash == nil {
		return nil
	}
	value, err := decodeRecord(raw)
	if err != nil {
		return err
	}
	verdict := objectField(value, "verdict")
	items := arrayField(verdict, "findings")
	if len(items) == 0 {
		return nil
	}
	source := record{"phase": "bootstrap", "recordHash": *r.BootstrapHash,
		"runId": value["runId"], "epoch": value["epoch"]}
	deferred := make([]record, 0, len(items))
	for _, item := range items {
		finding, _ := item.(record)
		deferred = append(deferred, record{
			"id": finding["id"], "sourceNode": "scout", "owner": verdict["owner"],
			"summary": finding["summary"],
			"status":  "deferred", "openedSequence": nil, "lastSeenSequence": nil, "closedSequence": nil,
			"source": source,
		})
	}
	slices.SortFunc(deferred, func(a, b record) int {
		return strings.Compare(stringField(a, "id"), stringField(b, "id"))
	})
	for _, status := range []string{"open", "closed", "deferred"} {
		for _, row := range r.Findings[status].([]record) {
			row["source"] = record{"phase": "route"}
		}
	}
	r.Findings["schema"] = 2
	r.Findings["deferred"] = append(deferred, r.Findings["deferred"].([]record)...)
	return nil
}

// Markdown сохраняет отчёт об отложенных находках в прежней форме.
func (r FindingsReport) Markdown() string {
	missing := func(hash *string, label string) string {
		if hash == nil {
			return label
		}
		return *hash
	}
	var output strings.Builder
	const title = "# Отложенные находки задачи %s\n\nПрофиль: %s; попытка: %s.\n"
	fmt.Fprintf(&output, title, r.Task, r.Profile, r.Attempt)
	fmt.Fprintf(&output, "Bootstrap: %s.\nStage ledger: %s.\n\n",
		missing(r.BootstrapHash, "отсутствует"), missing(r.StageLedgerHash, "не инициализирован"))
	output.WriteString("Маршрут не чинил эти находки. На приёмке реши, принять их как есть,\n" +
		"завести отдельные задачи или вернуть работу с явным требованием.\n\n")
	rows := r.Findings["deferred"].([]record)
	if len(rows) == 0 {
		output.WriteString("Отложенных находок нет.\n")
	}
	for _, row := range rows {
		phase := "маршрут"
		if objectField(row, "source")["phase"] == "bootstrap" {
			phase = "разведка"
		}
		fmt.Fprintf(&output, "- **%s** (%s, %s → %s): %s\n",
			row["id"], phase, row["sourceNode"], row["owner"], row["summary"])
	}
	return output.String()
}
