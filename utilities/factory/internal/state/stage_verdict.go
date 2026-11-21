package state

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var stageFindingPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// validateStageVerdict проверяет сохранённый typed verdict исторического события.
// Для done разрешены только отложенные находки.
func validateStageVerdict(value any, outcome string) error {
	if value == nil {
		return nil
	}
	verdict, _ := value.(record)
	owners := []string{"build", "tests", "environment", "plan", "human"}
	if (outcome != "done" && outcome != "failed") ||
		!fieldsOptional(verdict, []string{"owner", "findings"}, []string{"reviewed", "stage"}) ||
		!slices.Contains(owners, stringField(verdict, "owner")) {
		return fmt.Errorf("stage: неверный typed verdict")
	}
	findings := arrayField(verdict, "findings")
	if len(findings) == 0 || len(findings) > 32 {
		return fmt.Errorf("stage: неверное число findings")
	}
	seen := make(map[string]bool)
	blocking := 0
	for _, raw := range findings {
		finding, _ := raw.(record)
		id, err := validateStageFinding(finding, outcome)
		if err != nil || seen[id] {
			return fmt.Errorf("stage: неверная или повторная находка")
		}
		seen[id] = true
		if finding["severity"] != "deferred" {
			blocking++
		}
	}
	if hasRecordField(verdict, "reviewed") &&
		!uniqueTextList(arrayField(verdict, "reviewed"), 64, stageArtifact) {
		return fmt.Errorf("stage: неверный список reviewed")
	}
	if hasRecordField(verdict, "stage") {
		stage := objectField(verdict, "stage")
		if outcome != "failed" || blocking == 0 || !exactFields(stage, "kind", "closes", "summary") ||
			stage["kind"] != "next" ||
			!uniqueTextList(arrayField(stage, "closes"), 32, stageFindingPattern.MatchString) ||
			!stageText(stringField(stage, "summary"), 500) {
			return fmt.Errorf("stage: неверный вердикт о границе этапа")
		}
	}
	return nil
}

// validateStageFinding сверяет закрытые поля, качество текста и якорь.
// Блокирующая находка несовместима с успешным исходом.
func validateStageFinding(finding record, outcome string) (string, error) {
	id := stringField(finding, "id")
	if !fieldsOptional(finding, []string{"id", "summary"}, []string{"anchor", "severity"}) ||
		!stageFindingPattern.MatchString(id) || !stageText(stringField(finding, "summary"), 500) {
		return "", fmt.Errorf("stage: ошибочная находка")
	}
	if hasRecordField(finding, "anchor") && !stageArtifact(stringField(finding, "anchor")) {
		return "", fmt.Errorf("stage: ошибочный anchor")
	}
	if hasRecordField(finding, "severity") && finding["severity"] != "blocking" &&
		finding["severity"] != "deferred" {
		return "", fmt.Errorf("stage: ошибочный severity")
	}
	if outcome == "done" && finding["severity"] != "deferred" {
		return "", fmt.Errorf("stage: блокирующая находка при done")
	}
	return id, nil
}

func stageText(value string, maxLen int) bool {
	control := strings.ContainsFunc(value, func(char rune) bool {
		return char < 32 || char == 127
	})
	return value != "" && utf8.RuneCountInString(value) <= maxLen && !control
}

func stageArtifact(name string) bool {
	return stageText(name, 200) && !strings.HasPrefix(name, "/") &&
		!slices.Contains(strings.Split(name, "/"), "..")
}

// uniqueTextList проверяет проверяемый массив строк с предметной грамматикой элементов.
// Повтор не может продлить список рассмотренных артефактов или закрытых находок.
func uniqueTextList(items []any, limit int, valid func(string) bool) bool {
	if len(items) == 0 || len(items) > limit {
		return false
	}
	seen := make(map[string]bool)
	for _, item := range items {
		text, ok := item.(string)
		if !ok || seen[text] || !valid(text) {
			return false
		}
		seen[text] = true
	}
	return true
}

// fieldsOptional проверяет полный набор полей без неявных расширений схемы.
// В исторической записи известные опциональные поля можно опустить.
func fieldsOptional(value record, required, optional []string) bool {
	fields := slices.Clone(required)
	for _, name := range optional {
		if hasRecordField(value, name) {
			fields = append(fields, name)
		}
	}
	return exactFields(value, fields...)
}

// validateStageLoop восстанавливает число передач и stage по принятой цепочке.
// Snapshot подтверждает вычисленное состояние, а не устанавливает новое.
func (l *stageLedger) validateStageLoop(event record) error {
	pair := objectField(l.bundle.Machine, "loop")
	kind := stringField(event, "kind")
	if hasRecordField(event, "continues") != (kind == "loop-continue") {
		return fmt.Errorf("stage: неверная ссылка продолжения")
	}
	target := objectField(event, "action")["rewind"]
	transfer := pair != nil && event["node"] == pair["lead"] && target == pair["worker"]
	stopping := slices.Contains([]string{"rewind-limit", "no-progress", "loop-ceiling"}, kind)
	counts := transfer && (kind == "commit" || kind == "loop-continue")
	if !counts && !(transfer && stopping) {
		if hasRecordField(event, "loop") || kind == "loop-ceiling" || kind == "loop-continue" {
			return fmt.Errorf("stage: snapshot цикла вне передачи")
		}
		return nil
	}
	snapshot := objectField(event, "loop")
	fields := []string{"policy", "maxRounds", "roundsBefore", "roundsAfter", "stage", "stageAccepted"}
	if !fieldsOptional(snapshot, fields, []string{"stageRejected"}) ||
		snapshot["policy"] != json.Number("1") {
		return fmt.Errorf("stage: неверная форма snapshot цикла")
	}
	return l.checkLoopSnapshot(event, snapshot, counts)
}

// checkLoopSnapshot подтверждает ограничения политики и переносит счётчики.
// Событие остановки описывает кандидата, но не списывает круг.
func (l *stageLedger) checkLoopSnapshot(event, snapshot record, counts bool) error {
	limits := integerField(snapshot, "maxRounds")
	before, after := integerField(snapshot, "roundsBefore"), integerField(snapshot, "roundsAfter")
	accepted, typed := snapshot["stageAccepted"].(bool)
	hasStage := hasRecordField(objectField(event, "verdict"), "stage")
	wantStage := max(l.loopStage, 1)
	if accepted {
		wantStage = l.loopStage + 1
	}
	expected := l.loopRounds
	if counts {
		expected++
	}
	if limits < 1 || limits > 300 || before != l.loopRounds || after != expected || !typed ||
		integerField(snapshot, "stage") != wantStage || (accepted && !hasStage) ||
		(counts && after > limits) || (event["kind"] == "loop-ceiling" && before < limits) {
		return fmt.Errorf("stage: snapshot нарушает счётчики круга")
	}
	rejections := []string{"no-transfer", "no-worker-result", "result-used", "closes-mismatch", "ids-reused"}
	if hasRecordField(snapshot, "stageRejected") {
		if accepted || !hasStage || !slices.Contains(rejections, stringField(snapshot, "stageRejected")) {
			return fmt.Errorf("stage: неверная причина отклонения границы этапа")
		}
	} else if hasStage && !accepted {
		return fmt.Errorf("stage: отсутствует причина отклонения этапа")
	}
	if counts {
		l.loopRounds, l.loopStage = after, wantStage
	}
	return nil
}
