package state

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"grigdesk.local/tools/utilities/factory/internal/route"
)

var bootstrapVisitID = regexp.MustCompile(`^b_[a-f0-9]{32}$`)

type BootstrapDecision struct {
	VisitID, StopHash, Answer string
}

type bootstrapLedger struct {
	identity  record
	bundle    route.MachineBundle
	events    []record
	last      string
	visit     string
	stop      string
	decision  string
	completed bool
	answered  map[string]record
}

// AnswerBootstrap проверяет append-only остановку разведки под тем же task lock.
// Повтор дословного ответа идемпотентен и не создаёт main cursor.
func (s Store) AnswerBootstrap(a Attempt, decision BootstrapDecision) (map[string]any, bool, error) {
	if !bootstrapVisitID.MatchString(decision.VisitID) || !digestPattern.MatchString(decision.StopHash) ||
		!bootstrapText(decision.Answer) {
		return nil, false, fmt.Errorf("%w: неверный visit, stop hash или ответ", ErrConflict)
	}
	t, err := s.openTask(a.Task, true)
	if err != nil {
		return nil, false, err
	}
	defer t.close()
	current, err := t.readAttempt(a.Task, a.ID)
	if err != nil {
		return nil, false, err
	}
	active, err := t.activeAttempt(a.Task)
	if err != nil || active != a.ID || current.Terminal != "" || current != a {
		return nil, false, fmt.Errorf("%w: попытка разведки изменилась", ErrConflict)
	}
	ledger, dir, err := t.loadBootstrap(current)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil {
		return nil, false, err
	}
	existing, present := ledger.answered[decision.VisitID]
	if present && existing["stopHash"] == decision.StopHash {
		if existing["answer"] == decision.Answer {
			return existing, true, nil
		}
		return nil, false, fmt.Errorf("%w: на визит уже принят другой ответ", ErrConflict)
	}
	if dir == nil || ledger.visit != decision.VisitID || ledger.stop != decision.StopHash ||
		ledger.decision != "" || ledger.completed {
		return nil, false, fmt.Errorf("%w: устаревший визит или stop hash", ErrConflict)
	}
	receipt, err := ledger.appendReceipt(dir, "decision", decision.VisitID,
		record{"stopHash": decision.StopHash, "answer": decision.Answer})
	return receipt, false, err
}

// BootstrapWaiting читает только подтверждённую цепочку отдельной разведки.
// Main cursor не нужен для обнаружения вопроса.
func (s Store) BootstrapWaiting(a Attempt) (bool, error) {
	t, err := s.openTask(a.Task, false)
	if err != nil {
		return false, err
	}
	defer t.close()
	actual, err := t.readAttempt(a.Task, a.ID)
	if err != nil || actual != a {
		return false, fmt.Errorf("bootstrap: попытка изменилась")
	}
	ledger, dir, err := t.loadBootstrap(actual)
	if dir != nil {
		defer dir.Close()
	}
	if err != nil || ledger.stop == "" || ledger.decision != "" {
		return false, err
	}
	path := filepath.Join("attempts", a.ID, "artifacts", "bootstrap.json")
	if _, err := t.root.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("bootstrap: ожидающий вопрос требует отсутствия checkpoint")
	}
	return true, nil
}

func (t *taskState) loadBootstrap(a Attempt) (bootstrapLedger, *os.Root, error) {
	ledger := bootstrapLedger{
		identity: record{"protocolVersion": json.Number("2"), "taskId": a.Task, "attemptId": a.ID,
			"profile": a.Profile, "catalogHash": a.CatalogHash,
			"routeId": a.RouteID, "routeHash": a.RouteHash,
			"node": "scout", "runKey": "SCOUT"},
		answered: make(map[string]record),
	}
	name := filepath.Join("attempts", a.ID, "bootstrap-results")
	if err := ensurePrivateDirectory(t.root, name, false); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ledger, nil, nil
		}
		return ledger, nil, err
	}
	dir, err := t.root.OpenRoot(name)
	if err != nil {
		return ledger, nil, err
	}
	reader, err := route.NewBundleReader(a.RoutesDir, a.Profile)
	if err != nil {
		return ledger, dir, err
	}
	catalog, err := reader.ReadCatalog(a.CatalogHash)
	if err != nil {
		return ledger, dir, err
	}
	ledger.bundle = catalog.Bootstrap
	entries, err := fs.ReadDir(dir.FS(), ".")
	if err != nil {
		return ledger, dir, err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if err := ledger.addEvent(t.root, dir, entry.Name(), a); err != nil {
			return ledger, dir, err
		}
	}
	return ledger, dir, nil
}

func (l *bootstrapLedger) addEvent(attemptRoot, root *os.Root, name string, a Attempt) error {
	index := len(l.events) + 1
	if index > 4096 {
		return fmt.Errorf("bootstrap: слишком длинный журнал")
	}
	raw, err := readTrusted(root, name, 1024*1024, immutableMode)
	if err != nil || !jsontext.Value(raw).IsValid() {
		return fmt.Errorf("bootstrap: недоверенный файл события")
	}
	hash := digestOf(raw)
	if name != fmt.Sprintf("event.%020d.%s.json", index, hash) {
		return fmt.Errorf("bootstrap: неверный sequence или raw hash")
	}
	event, err := decodeRecord(raw)
	if err != nil {
		return err
	}
	canonical, err := bootstrapJSON(event)
	if err != nil || !bytes.Equal(raw, canonical) {
		return fmt.Errorf("bootstrap: неверный канонический JSON")
	}
	kind, visit := stringField(event, "kind"), stringField(event, "visitId")
	fields := []string{"schema", "phase", "sequence", "previousEventHash", "at", "kind", "visitId"}
	for key, value := range l.identity {
		if event[key] != value {
			return fmt.Errorf("bootstrap: чужая identity")
		}
		fields = append(fields, key)
	}
	payload := map[string][]string{
		"visit": {"decisionHash"}, "stop": {"outcome", "reason", "verdict", "runs", "transitionHash"},
		"decision": {"stopHash", "answer"}, "completed": {"checkpointHash"},
	}[kind]
	if payload == nil || !exactFields(event, append(fields, payload...)...) ||
		event["schema"] != json.Number("1") || event["phase"] != "bootstrap" ||
		event["previousEventHash"] != nilIfEmpty(l.last) || integerField(event, "sequence") != int64(index) ||
		!validTimestamp(stringField(event, "at")) || !bootstrapVisitID.MatchString(visit) || l.completed {
		return fmt.Errorf("bootstrap: неверный predecessor или kind")
	}
	if err := l.applyEvent(attemptRoot, a, event, kind, visit, hash); err != nil {
		return err
	}
	l.events = append(l.events, event)
	l.last = hash
	return nil
}

func (l *bootstrapLedger) applyEvent(
	attemptRoot *os.Root, a Attempt, event record, kind, visit, hash string,
) error {
	if kind == "visit" {
		if (l.stop != "" && l.decision == "") || event["decisionHash"] != nilIfEmpty(l.decision) {
			return fmt.Errorf("bootstrap: визит без решения человека")
		}
		for _, previous := range l.events {
			if previous["kind"] == "visit" && previous["visitId"] == visit {
				return fmt.Errorf("bootstrap: повторный visitId")
			}
		}
		l.visit, l.stop = visit, ""
		return nil
	}
	if l.visit == "" || l.visit != visit {
		return fmt.Errorf("bootstrap: событие другого визита")
	}
	switch kind {
	case "stop":
		if l.stop != "" {
			return fmt.Errorf("bootstrap: визит уже остановлен")
		}
		if err := l.verifyStop(event); err != nil {
			return err
		}
		l.stop, l.decision = hash, ""
	case "decision":
		if l.stop == "" || l.decision != "" || event["stopHash"] != l.stop ||
			!bootstrapText(stringField(event, "answer")) {
			return fmt.Errorf("bootstrap: ответ к другому вопросу")
		}
		l.decision = hash
		l.answered[visit] = bootstrapEvidence(event, hash)
	case "completed":
		raw, err := readTrusted(attemptRoot, filepath.Join("attempts", a.ID, "artifacts", "bootstrap.json"),
			1024*1024, immutableMode)
		if err != nil || l.stop != "" || event["checkpointHash"] != digestOf(raw) {
			return fmt.Errorf("bootstrap: завершение не связано с checkpoint")
		}
		l.completed = true
	}
	return nil
}

func (l bootstrapLedger) verifyStop(event record) error {
	outcome := stringField(event, "outcome")
	if !bootstrapText(stringField(event, "reason")) ||
		(outcome != "failed" && outcome != "skipped" && outcome != "exhausted") {
		return fmt.Errorf("bootstrap: неверная остановка")
	}
	if err := validateScoutRuns(arrayField(event, "runs"), outcome); err != nil {
		return err
	}
	hash, err := l.stopTransition(outcome, event["verdict"])
	if err != nil {
		return err
	}
	if event["transitionHash"] != hash {
		return fmt.Errorf("bootstrap: неверный transition hash")
	}
	return nil
}

// stopTransition связывает typed вердикт со stop:human закреплённой машины.
// Хэш считается из тех же байтов при публикации и чтении журнала.
func (l bootstrapLedger) stopTransition(outcome string, verdict any) (string, error) {
	var owner string
	if verdict != nil {
		raw, err := jsonv2.Marshal(verdict, jsonv2.Deterministic(true))
		if err != nil {
			return "", err
		}
		parsed, err := ParseRunVerdict(outcome, base64.StdEncoding.EncodeToString(raw))
		if err != nil {
			return "", err
		}
		if outcome == "failed" {
			owner = stringField(parsed, "owner")
		}
	}
	transition, err := l.bundle.Transition("scout", outcome, owner)
	if err != nil || objectField(transition, "action")["stop"] != "human" {
		return "", fmt.Errorf("bootstrap: остановка не подтверждена каталогом")
	}
	transition["schema"], transition["phase"] = 2, "bootstrap"
	transition["catalogHash"] = l.identity["catalogHash"]
	raw, err := bootstrapJSON(transition)
	return digestOf(raw), err
}

func validateScoutRuns(runs []any, outcome string) error {
	if len(runs) < 1 || len(runs) > 1000 {
		return fmt.Errorf("bootstrap: неверное число исполнений")
	}
	seen := make(map[string]bool)
	for i, raw := range runs {
		run, _ := raw.(record)
		id := stringField(run, "runId")
		epoch := integerField(run, "epoch")
		key := fmt.Sprintf("%s/%d", id, epoch)
		result := run["result"]
		if !exactFields(run, "runId", "epoch", "result") || !runIDPattern.MatchString(id) ||
			epoch < 1 || seen[key] || (result != nil && result != "failed" && result != "skipped") ||
			(outcome == "exhausted" && result != nil) ||
			(outcome != "exhausted" && i == len(runs)-1 && result != outcome) {
			return fmt.Errorf("bootstrap: неверная identity исполнения")
		}
		seen[key] = true
	}
	return nil
}

func (l bootstrapLedger) append(dir *os.Root, kind, id string, payload record) error {
	_, err := l.appendReceipt(dir, kind, id, payload)
	return err
}

// appendReceipt возвращает идентификатор ровно тех bytes, которые зафиксированы в журнале.
// Для повторного ответа такой же receipt восстанавливается при проверке цепочки.
func (l bootstrapLedger) appendReceipt(dir *os.Root, kind, id string, payload record) (record, error) {
	if len(l.events) >= 4096 {
		return nil, fmt.Errorf("bootstrap: исчерпан лимит событий")
	}
	event := record{
		"schema": 1, "phase": "bootstrap", "sequence": len(l.events) + 1, "kind": kind, "visitId": id,
		"previousEventHash": nilIfEmpty(l.last), "at": time.Now().UTC().Format(time.RFC3339),
	}
	for key, value := range l.identity {
		event[key] = value
	}
	for key, value := range payload {
		event[key] = value
	}
	raw, err := bootstrapJSON(event)
	if err != nil {
		return nil, err
	}
	hash := digestOf(raw)
	name := fmt.Sprintf("event.%020d.%s.json", len(l.events)+1, hash)
	if err := publishFile(dir, name, raw, immutableMode, false); err != nil {
		return nil, err
	}
	return bootstrapEvidence(event, hash), nil
}

func bootstrapJSON(value record) ([]byte, error) {
	raw, err := jsonv2.Marshal(value, jsonv2.Deterministic(true), jsontext.WithIndent("  "))
	return append(raw, '\n'), err
}

func nilIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func bootstrapText(value string) bool {
	if strings.TrimSpace(value) == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > 20000 {
		return false
	}
	return !strings.ContainsFunc(value, func(char rune) bool {
		return (char < 32 && char != '\n' && char != '\t') || char == 127
	})
}
