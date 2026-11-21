package route

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var (
	findingIDPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	findingRunPattern  = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	loopReportPattern  = regexp.MustCompile(`^report\.r[0-9]{1,3}(\.v[0-9]{1,4})?\.md$`)
	roundLimitPattern  = regexp.MustCompile(`^([1-9][0-9]?|[12][0-9]{2}|300)$`)
	findingStageFields = []string{"id", "sourceNode", "owner", "summary", "openedSequence",
		"lastSeenSequence", "status", "closedSequence"}
)

// evidence формирует ограниченный хвост результатов и typed findings.
// У цикла история хранится в журнале, а в промпт идут свежие записи и их счётчики.
func (o contextOptions) evidence(state, task, node string) (object, object, error) {
	loop, err := o.loopInfo(node)
	if err != nil {
		return nil, nil, err
	}
	maxBytes, maxRecords := maxContextFile, 2000
	if loop != nil {
		maxBytes, maxRecords = 32*1024*1024, 20000
	}
	raw, err := o.findingsInput(maxBytes)
	if err != nil {
		return nil, nil, err
	}
	findings, err := parseFindings(raw, maxBytes, maxRecords)
	if err != nil {
		return nil, nil, err
	}
	if loop != nil {
		findings = boundLoopFindings(findings)
	}
	count, _ := strconv.ParseInt(o.value("event-count"), 10, 64)
	if count < 0 {
		return nil, nil, fmt.Errorf("event-count: нужен неотрицательный integer")
	}
	stages, err := stageResults(o["stage-result"])
	if err != nil {
		return nil, nil, err
	}
	omitted := max(0, len(stages)-120)
	result := object{"eventCount": count, "stageResults": stages[omitted:], "findings": findings}
	if omitted > 0 {
		result["stageResultsOmitted"] = omitted
	}
	artifacts := contextArtifacts(state, task)
	if loop != nil {
		artifacts["report"] = filepath.Join(state, "t"+task+"."+textValue(loop["report"]))
		artifacts["baseline"] = filepath.Join(state, "t"+task+".baseline.md")
		delete(loop, "report")
		result["loop"] = loop
	}
	return result, artifacts, nil
}

// contextArtifacts сохраняет привычные адреса документов попытки.
// Пути вычисляются без чтения и без создания файлов состояния.
func contextArtifacts(state, task string) object {
	files := map[string]string{
		"recon": "recon.md", "plan": "plan.md", "diagnosis": "diag.md", "diagnosisRaw": "diag.raw.md",
		"testsDigest": "tests.sha256", "report": "report.md", "rejection": "reject.md",
		"reviewContract": "review-contract.md", "audit": "audit.md", "ship": "ship.md",
		"councilOpinionA": "council.opinion-a.md", "councilOpinionB": "council.opinion-b.md",
		"councilOpinionC": "council.opinion-c.md", "councilAggregate": "council.aggregate.json",
		"councilBrief": "council.brief.md",
	}
	result := make(object, len(files))
	for key, suffix := range files {
		result[key] = filepath.Join(state, "t"+task+"."+suffix)
	}
	return result
}

// stageResults проверяет порядок проекции коммитов и сохраняет его без сортировки.
// Ограничение длины общего списка допускает весь поддерживаемый периметр цикла.
func stageResults(entries []string) ([]object, error) {
	if len(entries) > 1000 {
		return nil, fmt.Errorf("stage-result: слишком много записей")
	}
	result := make([]object, 0, len(entries))
	previous := 0
	for index, raw := range entries {
		fields := contextResult.FindStringSubmatch(raw)
		if fields == nil {
			return nil, fmt.Errorf("stage-result[%d]: ожидался node:outcome:sequence", index)
		}
		sequence, _ := strconv.Atoi(fields[3])
		if sequence < 1 || sequence > 999999 {
			return nil, fmt.Errorf("stage-result[%d]: sequence вне диапазона", index)
		}
		if sequence < previous {
			return nil, fmt.Errorf("stage-result: записи должны идти по возрастанию sequence")
		}
		previous = sequence
		result = append(result, object{"node": fields[1], "outcome": fields[2], "sequence": sequence})
	}
	return result, nil
}

// findingsInput читает ровно один явно выбранный источник проекции.
// Файл используется для длинных историй, которые не помещаются в argv.
func (o contextOptions) findingsInput(limit int) (string, error) {
	file, hasFile := o["findings-ledger-file"]
	inline, hasInline := o["findings-ledger-json"]
	if !hasFile {
		if hasInline {
			return inline[0], nil
		}
		return `{"schema":1,"open":[],"closed":[]}`, nil
	}
	if hasInline {
		return "", fmt.Errorf("findings-ledger: нужен один источник — файл или JSON")
	}
	path := file[0]
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return "", fmt.Errorf("findings-ledger-file: нужен нормализованный абсолютный путь")
	}
	data, err := readContextFile(path, int64(limit))
	if err != nil {
		return "", fmt.Errorf("findings-ledger-file: %w", err)
	}
	return string(data), nil
}

// parseFindings проверяет обе независимые версии схемы проекции находок.
// Bootstrap и основной маршрут могут иметь одинаковый id находки без конфликта.
func parseFindings(raw string, byteLimit, recordLimit int) (object, error) {
	const label = "findings-ledger-json"
	if _, err := contextText(raw, label, 1, byteLimit); err != nil {
		return nil, err
	}
	value, err := parseObject([]byte(raw), label)
	if err != nil {
		return nil, err
	}
	if _, exists := value["deferred"]; !exists && value["schema"] == json.Number("1") {
		value["deferred"] = []any{}
	}
	if err := exactKeys(value, label, "schema", "open", "closed", "deferred"); err != nil {
		return nil, err
	}
	version, err := intRange(value["schema"], 1, 2, label+".schema")
	if err != nil {
		return nil, fmt.Errorf("%s.schema: поддерживаются 1 и 2", label)
	}
	seen := make(map[[3]string]bool)
	for _, status := range []string{"open", "closed", "deferred"} {
		records, ok := value[status].([]any)
		if !ok || len(records) > recordLimit {
			return nil, fmt.Errorf("%s.%s: ожидался массив до %d записей", label, status, recordLimit)
		}
		for index, raw := range records {
			record := objectValue(raw)
			recordLabel := fmt.Sprintf("%s.%s[%d]", label, status, index)
			identity, err := validateFinding(record, status, version, recordLabel)
			if err != nil {
				return nil, err
			}
			if seen[identity] {
				return nil, fmt.Errorf("%s: повтор finding %s/%s", recordLabel, identity[1], identity[2])
			}
			seen[identity] = true
		}
	}
	return value, nil
}

// validateFinding сверяет идентичность находки и числовые поля.
// Bootstrap откладывается с null sequence до появления отдельного журнала маршрута.
func validateFinding(record object, status string, version int, label string) ([3]string, error) {
	fields := findingStageFields
	if version == 2 {
		fields = append(slices.Clone(fields), "source")
	}
	identity := [3]string{}
	if err := exactKeys(record, label, fields...); err != nil {
		return identity, err
	}
	phase, err := findingPhase(record, version, label)
	if err != nil {
		return identity, err
	}
	id, err := identifier(record["id"], findingIDPattern, label+".id")
	if err != nil {
		return identity, err
	}
	node, err := identifier(record["sourceNode"], entityPattern, label+".sourceNode")
	if err != nil {
		return identity, err
	}
	if !inValues(failureOwners, record["owner"]) {
		return identity, fmt.Errorf("%s.owner: неизвестный владелец", label)
	}
	summary, err := contextText(record["summary"], label+".summary", 1, 500)
	if err != nil {
		return identity, err
	}
	if strings.ContainsFunc(summary, func(char rune) bool {
		return char < 32 || char == 127
	}) {
		return identity, fmt.Errorf("%s.summary: управляющие символы запрещены", label)
	}
	if record["status"] != status {
		return identity, fmt.Errorf("%s.status: не совпадает с секцией", label)
	}
	if err := findingSequences(record, status, phase, node, label); err != nil {
		return identity, err
	}
	return [3]string{phase, node, id}, nil
}

// findingPhase допускает source только объявленной версии.
// Идентичность bootstrap содержит точный хэш записи, runId и epoch.
func findingPhase(record object, version int, label string) (string, error) {
	if version == 1 {
		return "route", nil
	}
	source := objectValue(record["source"])
	phase := textValue(source["phase"])
	switch phase {
	case "route":
		return phase, exactKeys(source, label+".source", "phase")
	case "bootstrap":
		if err := exactKeys(source, label+".source", "phase", "recordHash", "runId", "epoch"); err != nil {
			return "", err
		}
		if _, err := identifier(source["recordHash"], digestPattern, label+".source.recordHash"); err != nil {
			return "", err
		}
		run, err := identifier(source["runId"], findingRunPattern, label+".source.runId")
		if err != nil || len(run) > 512 {
			return "", fmt.Errorf("%s.source.runId: недопустимый идентификатор", label)
		}
		epoch, _ := source["epoch"].(json.Number)
		value, err := epoch.Int64()
		if err != nil || value < 1 {
			return "", fmt.Errorf("%s.source.epoch: нужно целое от 1", label)
		}
		return phase, nil
	default:
		return "", fmt.Errorf("%s.source.phase: неизвестная фаза", label)
	}
}

// findingSequences проверяет порядок чисел и nullable поля по статусу.
// Нулевой sequence не превращается в отсутствие записи.
func findingSequences(record object, status, phase, node, label string) error {
	last := 0
	if phase == "bootstrap" {
		if status != "deferred" || node != "scout" ||
			record["openedSequence"] != nil || record["lastSeenSequence"] != nil {
			return fmt.Errorf("%s: bootstrap допускает только deferred с null sequence", label)
		}
	} else {
		opened, err := intRange(record["openedSequence"], 1, 999999, label+".openedSequence")
		if err != nil {
			return err
		}
		last, err = intRange(record["lastSeenSequence"], opened, 999999, label+".lastSeenSequence")
		if err != nil {
			return err
		}
	}
	if status == "closed" {
		_, err := intRange(record["closedSequence"], last, 999999, label+".closedSequence")
		return err
	}
	if record["closedSequence"] != nil {
		return fmt.Errorf("%s.closedSequence: у незакрытого finding нужен null", label)
	}
	return nil
}

// boundLoopFindings оставляет свежую историю каждой необязательной секции.
// Порядок выбранных записей остаётся исходным, а число пропусков отражается отдельно.
func boundLoopFindings(findings object) object {
	bounded := object{"schema": findings["schema"], "open": findings["open"]}
	omitted := make(map[string]int)
	for _, status := range []string{"closed", "deferred"} {
		records := arrayValue(findings[status])
		order := make([]int, len(records))
		for index := range order {
			order[index] = index
		}
		slices.SortStableFunc(order, func(a, b int) int {
			left := findingFreshness(status, objectValue(records[a]))
			right := findingFreshness(status, objectValue(records[b]))
			return slices.Compare(right[:], left[:])
		})
		used := 0
		keep := make([]bool, len(records))
		for _, index := range order {
			size := findingWireSize(records[index])
			if used+size > 16*1024 {
				break
			}
			keep[index] = true
			used += size
		}
		result := []any{}
		for index, record := range records {
			if keep[index] {
				result = append(result, record)
			}
		}
		bounded[status] = result
		if len(result) < len(records) {
			omitted[status] = len(records) - len(result)
		}
	}
	if len(omitted) > 0 {
		bounded["omitted"] = omitted
	}
	return bounded
}

// findingWireSize включает разделители прежней компактной сериализации.
// Двоеточия и запятые внутри строк не добавляют пробел к бюджету.
func findingWireSize(value any) int {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return 16*1024 + 1
	}
	size := buffer.Len() - 1
	quoted, escaped := false, false
	for _, byteValue := range buffer.Bytes() {
		switch {
		case escaped:
			escaped = false
		case quoted && byteValue == '\\':
			escaped = true
		case byteValue == '"':
			quoted = !quoted
		case !quoted && (byteValue == ',' || byteValue == ':'):
			size++
		}
	}
	return size
}

// findingFreshness определяет ключ сортировки по позиции в журнале.
// Нулевые sequence допустимы только после проверки схемы.
func findingFreshness(status string, record object) [3]int {
	if objectValue(record["source"])["phase"] == "bootstrap" {
		return [3]int{0, 0, 0}
	}
	if status == "closed" {
		return [3]int{1, intValue(record["closedSequence"]), intValue(record["lastSeenSequence"])}
	}
	return [3]int{1, intValue(record["lastSeenSequence"]), intValue(record["openedSequence"])}
}

// loopInfo добавляет роль, остаток кругов и утверждённое имя отчёта визита.
// Номера кругов берутся из проекции журнала и сверяются с потолком профиля.
func (o contextOptions) loopInfo(node string) (object, error) {
	raw, limit := o.value("loop-state-json"), o.value("loop-max-rounds")
	if raw == "" {
		if limit != "" {
			return nil, fmt.Errorf("loop-max-rounds без loop-state-json")
		}
		return nil, nil
	}
	state, err := parseObject([]byte(raw), "loop-state-json")
	if err != nil || state["schema"] != json.Number("1") {
		return nil, fmt.Errorf("loop-state-json: ожидалась schema=1")
	}
	loop := objectValue(state["loop"])
	if loop == nil {
		return nil, fmt.Errorf("loop-state-json: у маршрута нет цикла")
	}
	lead, err := identifier(loop["lead"], entityPattern, "loop.lead")
	if err != nil {
		return nil, err
	}
	worker, err := identifier(loop["worker"], entityPattern, "loop.worker")
	if err != nil {
		return nil, err
	}
	round, err := loopCount(loop["rounds"], "rounds")
	if err != nil {
		return nil, err
	}
	stage, err := loopCount(loop["stage"], "stage")
	if err != nil {
		return nil, err
	}
	if !roundLimitPattern.MatchString(limit) {
		return nil, fmt.Errorf("loop-max-rounds: нужно целое 1..300")
	}
	maxRounds, _ := strconv.ParseInt(limit, 10, 64)
	workerReport, lastReport := textValue(loop["workerReport"]), textValue(loop["lastReport"])
	if !loopReportPattern.MatchString(workerReport) {
		return nil, fmt.Errorf("loop-state-json: workerReport — имя отчёта визита")
	}
	if loop["lastReport"] != nil && !loopReportPattern.MatchString(lastReport) {
		return nil, fmt.Errorf("loop-state-json: lastReport — имя отчёта визита или null")
	}
	role := "other"
	report := lastReport
	if report == "" {
		report = fmt.Sprintf("report.r%d.md", round)
	}
	switch node {
	case lead:
		role = "lead"
	case worker:
		role, report = "worker", workerReport
	}
	return object{
		"role": role, "round": round, "maxRounds": maxRounds,
		"roundsLeft": max(0, maxRounds-round), "stage": stage, "report": report,
	}, nil
}

func loopCount(value any, label string) (int64, error) {
	number, _ := value.(json.Number)
	result, err := number.Int64()
	if err != nil || result < 0 {
		return 0, fmt.Errorf("loop-state-json: %s — неотрицательное целое", label)
	}
	return result, nil
}
