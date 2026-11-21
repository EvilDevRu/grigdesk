package state

import (
	"bytes"
	"encoding/base64"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"fmt"
	"slices"
	"strings"
)

const verdictLimit = 32 * 1024

// ParseRunVerdict принимает точные байты исторического typed verdict.
// Неверный UTF-8, повтор ключа и неканоническое представление отклоняются.
func ParseRunVerdict(result, encoded string) (map[string]any, error) {
	if encoded == "" {
		return nil, nil
	}
	if len(encoded) > base64.StdEncoding.EncodedLen(verdictLimit) || strings.ContainsAny(encoded, "\r\n") {
		return nil, fmt.Errorf("stage-result: превышен размер вердикта или испорчен base64")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) > verdictLimit || !jsontext.Value(data).IsValid() {
		return nil, fmt.Errorf("stage-result: вердикт требует канонический JSON в base64")
	}
	draft, err := decodeRecord(data)
	if err != nil {
		return nil, err
	}
	if err := checkRunVerdict(draft, result); err != nil {
		return nil, err
	}
	canonical, err := canonicalRunVerdict(draft)
	if err != nil || !bytes.Equal(canonical, data) {
		return nil, fmt.Errorf("stage-result: вердикт записан не в канонической форме")
	}
	return draft, nil
}

// EncodeRunVerdict разбирает прежние аргументы в точные структурированные поля.
// Bare failed остаётся допустим, а typed failed требует блокирующую находку.
func EncodeRunVerdict(result, owner string, inputs []string, lead bool) (string, error) {
	if !validRunResult(result) {
		return "", fmt.Errorf("stage-result: неверный результат")
	}
	if len(inputs) == 0 && owner == "" {
		return "", nil
	}
	if result != "done" && result != "failed" {
		return "", fmt.Errorf("stage-result: вердикт доступен для done и failed")
	}
	draft, err := prepareRunVerdict(owner, inputs, lead)
	if err != nil {
		return "", err
	}
	if result == "done" && draft["owner"] == "" {
		draft["owner"] = "build"
	}
	if err := checkRunVerdict(draft, result); err != nil {
		return "", err
	}
	data, err := canonicalRunVerdict(draft)
	if err != nil || len(data) > verdictLimit {
		return "", fmt.Errorf("stage-result: вердикт превышает 32 КиБ")
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// prepareRunVerdict сохраняет порядок находок и присоединяет якорь по id.
// Метаданные границы этапа принимаются только для доверенной роли lead.
func prepareRunVerdict(owner string, inputs []string, lead bool) (record, error) {
	draft := record{"owner": owner}
	var findings, reviewed, closed []any
	var kinds, summaries []string
	anchors := make(map[string]string)
	for _, input := range inputs {
		prefix, data, _ := strings.Cut(input, ":")
		switch prefix {
		case "reviewed":
			reviewed = append(reviewed, data)
		case "stage-closed":
			closed = append(closed, data)
		case "stage-summary":
			summaries = append(summaries, data)
		case "stage":
			kinds = append(kinds, data)
		case "anchor":
			id, path, ok := strings.Cut(data, "=")
			if _, duplicate := anchors[id]; !ok || duplicate || !stageArtifact(path) {
				return nil, fmt.Errorf("stage-result: anchor требует уникальный id=путь")
			}
			anchors[id] = path
		default:
			severity := ""
			if prefix == "deferred" {
				input, severity = data, "deferred"
			}
			id, summary, ok := strings.Cut(input, "=")
			if !ok {
				return nil, fmt.Errorf("stage-result: замечание требует id=краткое замечание")
			}
			finding := record{"id": id, "summary": summary}
			if severity != "" {
				finding["severity"] = severity
			}
			findings = append(findings, finding)
		}
	}
	for _, raw := range findings {
		finding := raw.(record)
		id := stringField(finding, "id")
		if path, exists := anchors[id]; exists {
			finding["anchor"] = path
			delete(anchors, id)
		}
	}
	if len(anchors) > 0 {
		return nil, fmt.Errorf("stage-result: якорь ссылается на отсутствующую находку")
	}
	draft["findings"] = findings
	if len(reviewed) > 0 {
		draft["reviewed"] = reviewed
	}
	if len(kinds)+len(summaries)+len(closed) > 0 {
		if !lead {
			return nil, fmt.Errorf("stage-result: граница этапа доступна только ведущему узлу цикла")
		}
		if !slices.Equal(kinds, []string{"next"}) || len(summaries) != 1 || len(closed) == 0 {
			return nil, fmt.Errorf("stage-result: нужны --next-stage, --stage-closed и --stage-summary")
		}
		draft["stage"] = record{"kind": "next", "closes": closed, "summary": summaries[0]}
	}
	return draft, nil
}

// checkRunVerdict использует ту же грамматику, что сохранённый stage ledger.
// Для отказа с typed metadata нужна как минимум одна блокирующая находка.
func checkRunVerdict(verdict record, result string) error {
	if err := validateStageVerdict(verdict, result); err != nil {
		return fmt.Errorf("stage-result: %w", err)
	}
	if result == "failed" {
		for _, raw := range arrayField(verdict, "findings") {
			if raw.(record)["severity"] != "deferred" {
				return nil
			}
		}
		return fmt.Errorf("stage-result: результат failed требует блокирующие находки")
	}
	return nil
}

// canonicalRunVerdict сериализует закрытую JSON форму с ASCII именами ключей.
// Отдельный codec сохраняет Python separators и буквальные UTF-8 символы.
func canonicalRunVerdict(value record) ([]byte, error) {
	return jsonv2.Marshal(value, jsonv2.Deterministic(true))
}
