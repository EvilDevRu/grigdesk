package graphworkflow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

type Definition struct {
	Title     string `json:"title"`
	InputKind string `json:"inputKind"`
	Scope     Scope  `json:"scope"`
}

type Scope struct {
	Steps   []Step   `json:"steps"`
	Returns []string `json:"returns"`
}

type Condition struct {
	Source string `json:"source"`
	Test   string `json:"test"`
}

// RetryTarget допускает одну цель либо объявленный список целей возврата.
type RetryTarget []string

// UnmarshalJSON читает компактную форму автора и единую форму хранения.
// Проверку принадлежности целей области затем выполняет validateStep.
func (targets *RetryTarget) UnmarshalJSON(raw []byte) error {
	var one string
	if json.Unmarshal(raw, &one) == nil && one != "" {
		*targets = RetryTarget{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err != nil {
		return fmt.Errorf("retryFrom: %w", err)
	}
	*targets = many
	return nil
}

type Step struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Kind        string      `json:"kind"`
	Needs       []string    `json:"needs,omitempty"`
	Reads       []string    `json:"reads,omitzero"`
	When        *Condition  `json:"when,omitempty"`
	Source      string      `json:"source,omitempty"`
	Scope       *Scope      `json:"scope,omitempty"`
	Prompt      string      `json:"prompt,omitempty"`
	Mode        string      `json:"mode,omitempty"`
	MinSuccess  int         `json:"minSuccess,omitempty"`
	Parallelism int         `json:"parallelism,omitempty"`
	MaxRounds   int         `json:"maxRounds,omitempty"`
	RetryFrom   RetryTarget `json:"retryFrom,omitzero"`
}

var stepID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

// DecodeDefinition проверяет один UTF-8 объект и все локальные связи.
// Одна и та же модель используется для записи редакции и снимка прогона.
func DecodeDefinition(raw []byte) (Definition, error) {
	var value Definition
	if len(raw) > 128*1024 || !utf8.Valid(raw) {
		return value, fmt.Errorf("document: превышен размер либо неверный UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&value); err != nil {
		return value, fmt.Errorf("document: %w", err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return value, fmt.Errorf("document: требуется один JSON-объект")
	}
	if !validTitle(value.Title) || (value.InputKind != "documents" && value.InputKind != "transcript") {
		return value, fmt.Errorf("document: неверные title или inputKind")
	}
	remaining := 32
	return value, validateScope(value.Scope, 1, false, value.InputKind, &remaining)
}

// validateScope держит namespace области и проверяет достижимость от её выходов.
// Вложенная область не получает возможности ссылаться на соседний экземпляр.
func validateScope(scope Scope, depth int, hasItem bool, inputKind string, remaining *int) error {
	if depth > 4 || len(scope.Steps) == 0 || len(scope.Returns) == 0 || len(scope.Steps) > *remaining {
		return fmt.Errorf("scope: пустая область либо превышен предел глубины или числа шагов")
	}
	*remaining -= len(scope.Steps)
	nodes := make(map[string]Step, len(scope.Steps))
	for _, node := range scope.Steps {
		if _, exists := nodes[node.ID]; exists || !stepID.MatchString(node.ID) || !validTitle(node.Title) {
			return fmt.Errorf("scope.steps: неверный id/title или повтор узла")
		}
		nodes[node.ID] = node
	}
	for _, node := range scope.Steps {
		if err := validateStep(node, nodes, depth, hasItem, inputKind, remaining); err != nil {
			return fmt.Errorf("steps.%s: %w", node.ID, err)
		}
	}
	seen := make(map[string]uint8)
	for _, id := range scope.Returns {
		if _, exists := nodes[id]; !exists {
			return fmt.Errorf("scope.returns: неизвестный шаг %s", id)
		}
		if err := visitScope(id, nodes, seen); err != nil {
			return err
		}
	}
	if len(seen) != len(nodes) || repeated(scope.Returns) {
		return fmt.Errorf("scope.returns: требуются различные выходы, покрывающие все шаги")
	}
	return nil
}

// validateStep ограничивает поля видом операции и проверяет её зависимости.
// Тип шага выбирается при сохранении, доступные действия закрепляет хост.
func validateStep(node Step, nodes map[string]Step, depth int, hasItem bool, inputKind string,
	remaining *int,
) error {
	if repeated(node.Needs) || repeated(node.Reads) {
		return fmt.Errorf("needs/reads: повтор ссылки")
	}
	for _, id := range node.Needs {
		if _, known := nodes[id]; !known {
			return fmt.Errorf("needs: неизвестный шаг %s", id)
		}
	}
	for _, id := range node.Reads {
		if id != "$inputs" && !(id == "$item" && hasItem) && !slices.Contains(node.Needs, id) {
			return fmt.Errorf("reads: ссылка вне зависимости")
		}
	}
	if node.When != nil {
		if node.Kind == "join" || !slices.Contains(node.Needs, node.When.Source) ||
			(node.When.Test != "empty" && node.When.Test != "nonempty") {
			return fmt.Errorf("when: неверная проверка зависимости")
		}
	}
	composite := node.Kind == "forEach" || node.Kind == "call" || node.Kind == "repeat"
	if (node.Scope != nil) != composite || (node.Source != "") != (node.Kind == "forEach") {
		return fmt.Errorf("scope/source: неверное поле для вида шага")
	}
	if node.Kind != "agent" && node.Prompt != "" || node.Kind != "join" && node.Kind != "forEach" && (node.Mode != "" || node.MinSuccess != 0) ||
		node.Kind != "repeat" && node.MaxRounds != 0 || node.Kind != "approval" && len(node.RetryFrom) > 0 {
		return fmt.Errorf("kind: поле не принадлежит этому виду шага")
	}
	if node.Parallelism < 0 || node.Parallelism > maxInstances || (node.Kind != "forEach" && node.Parallelism != 0) {
		return fmt.Errorf("parallelism: требуется целый предел веток для forEach")
	}
	switch node.Kind {
	case "input", "sections":
	case "meetingTasks":
		if inputKind != "transcript" {
			return fmt.Errorf("kind: разбор поручений требует расшифровку")
		}
	case "agent":
		if len(node.Prompt) > 8*1024 || strings.TrimSpace(node.Prompt) == "" {
			return fmt.Errorf("prompt: требуется инструкция до 8 КиБ")
		}
	case "approval":
		if len(node.Needs) == 0 || repeated(node.RetryFrom) {
			return fmt.Errorf("retryFrom: нужны уникальные предшествующие шаги")
		}
		for _, target := range node.RetryFrom {
			if !ancestor(target, node.Needs, nodes, make(map[string]bool)) {
				return fmt.Errorf("retryFrom: неизвестный предок %s", target)
			}
		}
	case "join":
		if len(node.Needs) == 0 {
			return fmt.Errorf("needs: сборке нужны входы")
		}
		switch node.Mode {
		case "", "all", "any":
			if node.MinSuccess != 0 {
				return fmt.Errorf("minSuccess: поле задано для сборки по кворуму")
			}
		case "quorum":
			if node.MinSuccess < 1 || node.MinSuccess > len(node.Needs) {
				return fmt.Errorf("minSuccess: порог недостижим")
			}
		default:
			return fmt.Errorf("mode: неизвестное правило сборки")
		}
	case "forEach", "call", "repeat":
		if node.Kind == "forEach" {
			if !slices.Contains(node.Needs, node.Source) {
				return fmt.Errorf("source: нужен источник из needs")
			}
			if err := validateGroupMode(node.Mode, node.MinSuccess); err != nil {
				return err
			}
		}
		if node.Kind == "repeat" && (node.MaxRounds < 1 || node.MaxRounds > 5) {
			return fmt.Errorf("maxRounds: допустимо от 1 до 5")
		}
		return validateScope(*node.Scope, depth+1, hasItem || node.Kind == "forEach", inputKind, remaining)
	default:
		return fmt.Errorf("kind: неизвестный тип")
	}
	return nil
}

// validateGroupMode проверяет правило до появления списка экземпляров.
// Группа позже сверяет достижимость выбранного порога с фактическим числом элементов.
func validateGroupMode(mode string, minimum int) error {
	switch mode {
	case "", "all", "any":
		if minimum == 0 {
			return nil
		}
	case "quorum":
		if minimum >= 1 && minimum <= maxInstances {
			return nil
		}
	}
	return fmt.Errorf("mode/minSuccess: неверное правило для динамической группы")
}

// visitScope идёт по зависимостям и сохраняет цвет посещения.
// Ребро на текущем стеке даёт цикл до записи маршрута.
func visitScope(id string, nodes map[string]Step, seen map[string]uint8) error {
	switch seen[id] {
	case 1:
		return fmt.Errorf("scope.needs: cycle у %s", id)
	case 2:
		return nil
	}
	seen[id] = 1
	for _, need := range nodes[id].Needs {
		if err := visitScope(need, nodes, seen); err != nil {
			return err
		}
	}
	seen[id] = 2
	return nil
}

// ancestor ограничивает возврат зависимостями данной области.
// Set защищает обход даже пока основной валидатор ещё проверяет цикл.
func ancestor(target string, needs []string, nodes map[string]Step, seen map[string]bool) bool {
	for _, id := range needs {
		if id == target {
			return true
		}
		if !seen[id] {
			seen[id] = true
			if ancestor(target, nodes[id].Needs, nodes, seen) {
				return true
			}
		}
	}
	return false
}

func validTitle(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.RuneCountInString(value) <= 120
}

// repeated проверяет списки ссылок до формирования ключей.
// Порядок исходного списка остаётся доступен для сборки.
func repeated(ids []string) bool {
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			return true
		}
		seen[id] = true
	}
	return false
}
