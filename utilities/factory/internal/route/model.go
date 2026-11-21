package route

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"
)

var (
	runKeyPattern      = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	contextPathPattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`)
	failureOwners      = []string{"build", "tests", "environment", "plan", "human"}
	filesystemPolicies = []string{"state-only", "workspace-write", "transactional-write"}
	timeoutClasses     = []string{"planning", "standard", "review", "delivery", "check", "test", "build",
		"diagnostic", "browser"}
	retryStrategies = []string{"none", "same-runner", "runner-failover"}
)

type machineModel struct {
	data       object
	nodes      map[string]object
	orderedIDs []string
	positions  map[string]int
	phases     map[string]string
	escalation map[string]object
}

func objectValue(value any) object {
	result, _ := value.(object)
	return result
}

func textValue(value any) string {
	result, _ := value.(string)
	return result
}

func arrayValue(value any) []any {
	result, _ := value.([]any)
	return result
}

func intValue(value any) int {
	number, _ := value.(json.Number)
	result, _ := number.Int64()
	return int(result)
}

func intRange(value any, low, high int, label string) (int, error) {
	number, _ := value.(json.Number)
	result, err := number.Int64()
	if err != nil || result < int64(low) || result > int64(high) {
		return 0, fmt.Errorf("%s: ожидалось целое %d…%d", label, low, high)
	}
	return int(result), nil
}

func inValues(items []string, value any) bool {
	text, ok := value.(string)
	return ok && slices.Contains(items, text)
}

func containsValue(items []any, value string) bool {
	return slices.Contains(items, any(value))
}

// sortedKeys обеспечивает повторяемые диагностики для объектов JSON.
// Порядок массива сохраняется отдельно, например у списка узлов и блоков промпта.
func sortedKeys[T any](value map[string]T) []string {
	keys := make([]string, 0, len(value))
	for name := range value {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	return keys
}

// optionalKeys проверяет обязательные поля и известные расширения схемы.
// Отдельные версии машины используют разные допустимые поля.
func optionalKeys(value object, label string, required, optional []string) error {
	fields := append([]string(nil), required...)
	for _, field := range optional {
		if _, exists := value[field]; exists {
			fields = append(fields, field)
		}
	}
	return exactKeys(value, label, fields...)
}

// uniqueIDs принимает упорядоченный список валидных идентификаторов.
// Повтор означает неоднозначную последовательность операций.
func uniqueIDs(value any, label string, allowEmpty bool) ([]string, error) {
	items, ok := value.([]any)
	if !ok || (!allowEmpty && len(items) == 0) {
		return nil, fmt.Errorf("%s: ожидался массив идентификаторов", label)
	}
	result := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for index, item := range items {
		id, err := identifier(item, entityPattern, fmt.Sprintf("%s[%d]", label, index))
		if err != nil {
			return nil, err
		}
		if seen[id] {
			return nil, fmt.Errorf("%s: повтор %s", label, id)
		}
		result = append(result, id)
		seen[id] = true
	}
	return result, nil
}

// checkNoModelPolicy проверяет вложенную структуру независимо от типа узла.
// Поставщик, модель и усилие выбираются из runners.env.
func checkNoModelPolicy(value any, label string) error {
	switch value := value.(type) {
	case object:
		for _, key := range sortedKeys(value) {
			field := label + "." + key
			if key == "model" || key == "effort" || key == "provider" {
				return fmt.Errorf("%s: модельная политика живёт только в runners.env", field)
			}
			if err := checkNoModelPolicy(value[key], field); err != nil {
				return err
			}
		}
	case []any:
		for index, child := range value {
			if err := checkNoModelPolicy(child, fmt.Sprintf("%s[%d]", label, index)); err != nil {
				return err
			}
		}
	}
	return nil
}

// validateMachine проверяет общую структуру бандлов и черновиков.
// Старым закреплённым маршрутам разрешён исторический бюджет productFailure.
func validateMachine(bundle MachineBundle, profile, id, kind string, history bool) (machineModel, error) {
	data := bundle.Machine
	model := machineModel{
		data: data, nodes: make(map[string]object), positions: make(map[string]int),
		phases: make(map[string]string), escalation: make(map[string]object),
	}
	if err := checkNoModelPolicy(data, "$"); err != nil {
		return model, err
	}
	optional := []string{"title"}
	if kind == "route" {
		optional = append(optional, "bootstrap", "loop")
	}
	required := []string{"schema", "kind", "profile", "id", "entry", "sequence", "nodes", "escalation"}
	if err := optionalKeys(data, "machine", required, optional); err != nil {
		return model, err
	}
	if !schemaV2(data) || data["kind"] != kind || data["profile"] != profile || data["id"] != id {
		return model, fmt.Errorf("machine: schema/kind/profile/id не совпадают с bundle")
	}
	if title, exists := data["title"]; exists && !displayText(title, 200) {
		return model, fmt.Errorf("machine.title: недопустимая строка")
	}
	if bootstrap, exists := data["bootstrap"]; exists && bootstrap != "required" && bootstrap != "skip" {
		return model, fmt.Errorf("machine.bootstrap: нужны required или skip")
	}
	if err := model.readSequence(kind); err != nil {
		return model, err
	}
	if err := model.readNodes(bundle.Prompts, kind); err != nil {
		return model, err
	}
	if kind == "route" {
		if err := model.validateDelivery(); err != nil {
			return model, err
		}
	}
	if err := model.validateRegistry(); err != nil {
		return model, err
	}
	if err := model.readEscalation(); err != nil {
		return model, err
	}
	if err := model.validateTransitions(history); err != nil {
		return model, err
	}
	if err := model.validatePromptSet(bundle.Prompts); err != nil {
		return model, err
	}
	if _, exists := data["loop"]; exists {
		return model, model.validateLoop()
	}
	return model, nil
}

func displayText(value any, limit int) bool {
	text := textValue(value)
	return text != "" && utf8.RuneCountInString(text) <= limit
}

// readSequence строит порядок и фазы исполняемых узлов.
// Entry у bootstrap всегда открывает первый и отдельный подготовительный визит.
func (m *machineModel) readSequence(kind string) error {
	phases := []string{"main", "tail"}
	if kind == "bootstrap" {
		phases = []string{"bootstrap"}
	}
	sequence := objectValue(m.data["sequence"])
	if err := exactKeys(sequence, "machine.sequence", phases...); err != nil {
		return err
	}
	for _, phase := range phases {
		items, ok := sequence[phase].([]any)
		if !ok || (phase != "tail" && len(items) == 0) {
			return fmt.Errorf("machine.sequence.%s: недопустимая последовательность", phase)
		}
		for _, item := range items {
			name, err := identifier(item, entityPattern, "machine.sequence."+phase)
			if err != nil {
				return err
			}
			if _, exists := m.phases[name]; exists {
				return fmt.Errorf("machine.sequence: повтор узла %s", name)
			}
			m.phases[name] = phase
			m.positions[name] = len(m.orderedIDs)
			m.orderedIDs = append(m.orderedIDs, name)
		}
	}
	entry := textValue(m.data["entry"])
	if m.phases[entry] != phases[0] {
		return fmt.Errorf("machine.entry: нужен исполняемый узел %s", phases[0])
	}
	if kind == "bootstrap" && entry != m.orderedIDs[0] {
		return fmt.Errorf("bootstrap.entry должен быть первым узлом sequence")
	}
	return nil
}

// readNodes индексирует узлы только после проверки обязательных полей.
// Исполняемые узлы и status проекции имеют отдельные схемы.
func (m machineModel) readNodes(prompts map[string]string, kind string) error {
	values := arrayValue(m.data["nodes"])
	if len(values) == 0 {
		return fmt.Errorf("machine.nodes: нужен непустой список")
	}
	executable := 0
	for index, raw := range values {
		label := fmt.Sprintf("machine.nodes[%d]", index)
		node := objectValue(raw)
		if node == nil {
			return fmt.Errorf("%s: ожидался объект", label)
		}
		id, err := identifier(node["id"], entityPattern, label+".id")
		if err != nil {
			return err
		}
		if _, exists := m.nodes[id]; exists {
			return fmt.Errorf("machine.nodes: повтор %s", id)
		}
		if err := validateNodeShape(node, label, id); err != nil {
			return err
		}
		if node["executor"] != "status" {
			executable++
		}
		m.nodes[id] = node
	}
	if len(m.orderedIDs) != executable {
		return fmt.Errorf("machine.sequence должна перечислять все исполняемые узлы")
	}
	for _, raw := range values {
		node := objectValue(raw)
		if node["executor"] == "status" {
			continue
		}
		id := textValue(node["id"])
		if m.phases[id] != node["phase"] {
			return fmt.Errorf("machine.nodes.%s: phase не совпадает с sequence", id)
		}
		if err := validateExecutableNode(node, "machine.nodes."+id, kind, prompts); err != nil {
			return err
		}
	}
	return nil
}

// validateNodeShape проверяет набор полей одного узла по executor.
// Отображаемые метки необязательны и ограничены отдельно от идентификатора.
func validateNodeShape(node object, label, id string) error {
	required := []string{"id", "executor", "phase"}
	optional := []string{"label", "description"}
	if !inValues([]string{"bootstrap", "main", "tail"}, node["phase"]) {
		return fmt.Errorf("machine.nodes.%s: неизвестный executor/phase", id)
	}
	switch node["executor"] {
	case "agent", "command":
		required = append(required, "runKey", "emits", "policy", "fanout", "retry", "on")
		optional = append(optional, "onFailure")
		if node["executor"] == "agent" {
			required = append(required, "prompt")
		} else {
			required = append(required, "commandId")
		}
	case "gate":
		required = append(required, "runKey", "emits", "on")
	case "status":
		required = append(required, "key", "owner")
	default:
		return fmt.Errorf("machine.nodes.%s: неизвестный executor/phase", id)
	}
	if err := optionalKeys(node, label, required, optional); err != nil {
		return err
	}
	for _, field := range []string{"label", "description"} {
		if value, exists := node[field]; exists && !displayText(value, 500) {
			return fmt.Errorf("machine.nodes.%s.%s: недопустимая строка", id, field)
		}
	}
	return nil
}

// validateExecutableNode проверяет локальный контракт перед разрешением дуг.
// Command выполняется один раз, а агент получает отдельные настройки повторов.
func validateExecutableNode(node object, label, kind string, prompts map[string]string) error {
	key, err := identifier(node["runKey"], runKeyPattern, label+".runKey")
	if err != nil {
		return err
	}
	if node["id"] != strings.ToLower(key) {
		return fmt.Errorf("%s: id обязан равняться runKey.lower()", label)
	}
	if _, err := uniqueIDs(node["emits"], label+".emits", true); err != nil {
		return err
	}
	outcomes := []string{"done", "skipped", "failed", "exhausted"}
	if node["executor"] == "gate" {
		outcomes = []string{"approved", "rejected"}
	}
	if exactKeys(objectValue(node["on"]), label+".on", outcomes...) != nil {
		return fmt.Errorf("%s.on: outcomes описаны не полностью", label)
	}
	if node["executor"] == "gate" {
		return nil
	}
	if err := validateRunPolicy(node, label); err != nil {
		return err
	}
	if failure, exists := node["onFailure"]; exists {
		if err := exactKeys(objectValue(failure), label+".onFailure", failureOwners...); err != nil {
			return err
		}
	}
	if node["executor"] == "command" {
		_, err := identifier(node["commandId"], entityPattern, label+".commandId")
		return err
	}
	prefix := "prompts/"
	if kind == "bootstrap" {
		prefix = "bootstrap/prompts/"
	}
	return validatePrompt(objectValue(node["prompt"]), prompts, prefix, label+".prompt")
}

// validateRunPolicy проверяет файловые права, способ fanout и повтор команд.
// Одно правило применяется к immutable каталогу и черновику.
func validateRunPolicy(node object, label string) error {
	policy := objectValue(node["policy"])
	if err := validatePolicy(policy, label+".policy"); err != nil {
		return err
	}
	fanout := objectValue(node["fanout"])
	if err := validateFanout(fanout, label+".fanout"); err != nil {
		return err
	}
	retry := objectValue(node["retry"])
	if err := validateRetry(retry, label+".retry"); err != nil {
		return err
	}
	if fanout["mode"] == "parallel" && policy["filesystem"] != "state-only" {
		return fmt.Errorf("%s.fanout: parallel разрешён только для state-only узла", label)
	}
	if node["executor"] != "command" {
		return nil
	}
	if fanout["mode"] != "single" {
		return fmt.Errorf("%s.fanout: command обязан быть single", label)
	}
	if policy["filesystem"] == "transactional-write" {
		const message = "%s.policy.filesystem: command поддерживает только state-only/workspace-write"
		return fmt.Errorf(message, label)
	}
	if intValue(retry["noResult"]) != 0 || intValue(retry["productFailure"]) != 0 ||
		intValue(objectValue(retry["providerFailure"])["attempts"]) != 0 {
		return fmt.Errorf("%s.retry: command исполняется ровно один раз без runner retry", label)
	}
	return nil
}

// validatePolicy проверяет независимые права узла на файловую систему и браузер.
// Классы timeout ограничены списком движка, budget остаётся идентификатором.
func validatePolicy(policy object, label string) error {
	required := []string{"filesystem"}
	optional := []string{"timeoutClass", "budgetClass", "browser"}
	if err := optionalKeys(policy, label, required, optional); err != nil {
		return err
	}
	if !inValues(filesystemPolicies, policy["filesystem"]) {
		return fmt.Errorf("%s.filesystem: неизвестная политика", label)
	}
	if timeout, exists := policy["timeoutClass"]; exists {
		if _, err := identifier(timeout, entityPattern, label+".timeoutClass"); err != nil {
			return err
		}
		if !inValues(timeoutClasses, timeout) {
			return fmt.Errorf("%s.timeoutClass: неизвестный класс", label)
		}
	}
	if budget, exists := policy["budgetClass"]; exists {
		if _, err := identifier(budget, entityPattern, label+".budgetClass"); err != nil {
			return err
		}
	}
	if browser, exists := policy["browser"]; exists && browser != "forbid" && browser != "allow" {
		return fmt.Errorf("%s.browser: допустимо forbid или allow", label)
	}
	return nil
}

// validateFanout ограничивает параллельность и допустимую деградацию.
// Single всегда означает одного исполнителя без деградации.
func validateFanout(fanout object, label string) error {
	if err := exactKeys(fanout, label, "mode", "maxExecutors", "degrade"); err != nil {
		return err
	}
	if fanout["mode"] != "single" && fanout["mode"] != "parallel" {
		return fmt.Errorf("%s.mode: неизвестный режим", label)
	}
	count, err := intRange(fanout["maxExecutors"], 1, 16, label+".maxExecutors")
	if err != nil {
		return err
	}
	if fanout["degrade"] != "forbid" && fanout["degrade"] != "allow-single" {
		return fmt.Errorf("%s.degrade: неизвестная деградация", label)
	}
	if fanout["mode"] == "single" && (count != 1 || fanout["degrade"] != "forbid") {
		return fmt.Errorf("%s: single требует maxExecutors=1 и degrade=forbid", label)
	}
	if fanout["mode"] == "parallel" && count < 2 {
		return fmt.Errorf("%s: parallel требует минимум двух исполнителей", label)
	}
	return nil
}

// validateRetry сверяет самостоятельные бюджеты и стратегию сбоя провайдера.
// Нулевой бюджет провайдера должен быть выражен стратегией none.
func validateRetry(retry object, label string) error {
	if err := exactKeys(retry, label, "noResult", "providerFailure", "productFailure"); err != nil {
		return err
	}
	for _, field := range []string{"noResult", "productFailure"} {
		if _, err := intRange(retry[field], 0, 10, label+"."+field); err != nil {
			return err
		}
	}
	provider := objectValue(retry["providerFailure"])
	if err := exactKeys(provider, label+".providerFailure", "attempts", "strategy"); err != nil {
		return err
	}
	count, err := intRange(provider["attempts"], 0, 10, label+".providerFailure.attempts")
	if err != nil {
		return err
	}
	if !inValues(retryStrategies, provider["strategy"]) {
		return fmt.Errorf("%s.providerFailure.strategy: неизвестная стратегия", label)
	}
	if (count == 0) != (provider["strategy"] == "none") {
		return fmt.Errorf("%s.providerFailure: strategy=none эквивалентна attempts=0", label)
	}
	return nil
}

// validatePrompt проверяет связь блоков с опубликованными файлами и секциями.
// Выражение when состоит исключительно из ссылки на секцию и скаляра JSON.
func validatePrompt(prompt object, files map[string]string, prefix, label string) error {
	if err := exactKeys(prompt, label, "blocks", "requiredContext"); err != nil {
		return err
	}
	roots := arrayValue(prompt["requiredContext"])
	if len(roots) == 0 {
		return fmt.Errorf("%s.requiredContext: нужен непустой список", label)
	}
	seen := make(map[string]bool, len(roots))
	for index, value := range roots {
		root := textValue(value)
		if !contextPathPattern.MatchString(root) || strings.Contains(root, ".") ||
			root == "model" || root == "effort" || root == "provider" {
			return fmt.Errorf("%s.requiredContext[%d]: нужен корневой context key", label, index)
		}
		if seen[root] {
			return fmt.Errorf("%s.requiredContext: повтор %s", label, root)
		}
		seen[root] = true
	}
	blocks := arrayValue(prompt["blocks"])
	if len(blocks) == 0 {
		return fmt.Errorf("%s.blocks: нужен непустой список", label)
	}
	for index, raw := range blocks {
		block := objectValue(raw)
		position := fmt.Sprintf("%s.blocks[%d]", label, index)
		if err := optionalKeys(block, position, []string{"file"}, []string{"when"}); err != nil {
			return err
		}
		file := textValue(block["file"])
		if _, exists := files[file]; !exists || !strings.HasPrefix(file, prefix) {
			return fmt.Errorf("%s.file: файл отсутствует или имеет неверный prefix", position)
		}
		if raw, exists := block["when"]; exists {
			if err := validateCondition(objectValue(raw), seen, position+".when"); err != nil {
				return err
			}
		}
	}
	return nil
}

// validateCondition ограничивает источник значения объявленной секцией.
// Условия рендера не получают интерпретатор команд и сложные операнды.
func validateCondition(when object, roots map[string]bool, label string) error {
	if err := exactKeys(when, label, "context", "equals"); err != nil {
		return err
	}
	path := textValue(when["context"])
	root, _, _ := strings.Cut(path, ".")
	if !contextPathPattern.MatchString(path) || !roots[root] {
		return fmt.Errorf("%s.context: секция не объявлена в requiredContext", label)
	}
	switch expected := when["equals"].(type) {
	case nil, string, bool:
		return nil
	case json.Number:
		number, err := expected.Float64()
		if err == nil && !math.IsInf(number, 0) && !math.IsNaN(number) {
			return nil
		}
	}
	return fmt.Errorf("%s.equals: разрешён только JSON scalar", label)
}

// validateDelivery требует одного канонического узла передачи результата в tail.
// Остальные узлы не получают файловые и контекстные возможности доставки.
func (m machineModel) validateDelivery() error {
	ship := m.nodes["ship"]
	if ship != nil {
		policy := objectValue(ship["policy"])
		required := arrayValue(objectValue(ship["prompt"])["requiredContext"])
		if ship["executor"] != "agent" || m.phases["ship"] != "tail" || ship["runKey"] != "SHIP" ||
			policy["filesystem"] != "workspace-write" || policy["timeoutClass"] != "delivery" ||
			!containsValue(required, "delivery") {
			return fmt.Errorf("machine.nodes.ship: publish-маршрут требует канонический delivery-узел в tail")
		}
	}
	for _, id := range m.orderedIDs {
		if id == "ship" {
			continue
		}
		node := m.nodes[id]
		policy := objectValue(node["policy"])
		required := arrayValue(objectValue(node["prompt"])["requiredContext"])
		if node["runKey"] == "SHIP" || policy["timeoutClass"] == "delivery" ||
			containsValue(required, "delivery") {
			if ship == nil {
				return fmt.Errorf("machine: delivery-capability запрещена в маршруте без узла ship")
			}
			return fmt.Errorf("machine: delivery-capability разрешена только каноническому узлу ship")
		}
	}
	return nil
}

// validateRegistry связывает status с владельцем и проверяет уникальность реестра.
// У каждого записываемого ключа существует только один узел.
func (m machineModel) validateRegistry() error {
	keys := make(map[string]string)
	for _, raw := range arrayValue(m.data["nodes"]) {
		node := objectValue(raw)
		id := textValue(node["id"])
		key := textValue(node["runKey"])
		if node["executor"] == "status" {
			var err error
			key, err = identifier(node["key"], runKeyPattern, "status."+id+".key")
			if err != nil {
				return err
			}
			ownerID, err := identifier(node["owner"], entityPattern, "status."+id+".owner")
			if err != nil {
				return err
			}
			owner := m.nodes[ownerID]
			if owner == nil || owner["executor"] == "status" || owner["phase"] != node["phase"] ||
				!containsValue(arrayValue(owner["emits"]), id) {
				return fmt.Errorf("status.%s: owner↔emits нарушен", id)
			}
		}
		if previous := keys[key]; previous != "" {
			return fmt.Errorf("machine.nodes: ключ состояния %s повторяется у %s и %s", key, previous, id)
		}
		keys[key] = id
	}
	return nil
}

// readEscalation строит политику для каждого исходного узла.
// Ворота для закреплённого маршрута принадлежат только объявленной политике.
func (m machineModel) readEscalation() error {
	entries, ok := m.data["escalation"].([]any)
	if !ok {
		return fmt.Errorf("machine.escalation: ожидался массив")
	}
	for index, raw := range entries {
		label := fmt.Sprintf("machine.escalation[%d]", index)
		entry := objectValue(raw)
		if err := exactKeys(entry, label, "from", "allowedRoutes", "requiresHumanWhenPinned"); err != nil {
			return err
		}
		source, err := identifier(entry["from"], entityPattern, label+".from")
		if err != nil {
			return err
		}
		if m.escalation[source] != nil {
			return fmt.Errorf("machine.escalation: повтор source %s", source)
		}
		if node := m.nodes[source]; node == nil || node["executor"] == "status" {
			return fmt.Errorf("%s.from: нужен исполняемый узел", label)
		}
		if _, err := uniqueIDs(entry["allowedRoutes"], label+".allowedRoutes", false); err != nil {
			return err
		}
		if _, ok := entry["requiresHumanWhenPinned"].(bool); !ok {
			return fmt.Errorf("%s.requiresHumanWhenPinned: ожидался boolean", label)
		}
		m.escalation[source] = entry
	}
	return nil
}

// validateTransitions проверяет адреса дуг, принадлежность status и достижимость.
// У rewind сбрасывается непрерывный отрезок от цели до исходного узла.
func (m machineModel) validateTransitions(history bool) error {
	links := make(map[string][]string)
	for _, raw := range arrayValue(m.data["nodes"]) {
		node := objectValue(raw)
		if node["executor"] == "status" {
			continue
		}
		id := textValue(node["id"])
		for _, raw := range arrayValue(node["emits"]) {
			status := m.nodes[textValue(raw)]
			if status["executor"] != "status" || status["owner"] != id {
				return fmt.Errorf("machine.nodes.%s.emits: обратная status-ссылка нарушена", id)
			}
		}
		for _, channel := range []string{"on", "onFailure"} {
			transitions := objectValue(node[channel])
			for _, outcome := range sortedKeys(transitions) {
				label := fmt.Sprintf("machine.nodes.%s.%s.%s", id, channel, outcome)
				action := objectValue(transitions[outcome])
				mode, err := validateAction(action, label)
				if err != nil {
					return err
				}
				if mode == "rewind" && !history && (outcome == "failed" || channel == "onFailure") &&
					intValue(objectValue(node["retry"])["productFailure"]) > 0 {
					const message = "machine.nodes.%s.retry.productFailure: productFailure должен быть 0 — " +
						"failed уже возвращает работу на %s"
					return fmt.Errorf(message, id, action["rewind"])
				}
				target, err := m.validateArc(id, label, mode, action)
				if err != nil {
					return err
				}
				if target != "" {
					links[id] = append(links[id], target)
				}
			}
		}
	}
	return m.validateReachability(links)
}

// validateAction проверяет один вариант перехода и его локальные параметры.
// Обход структуры с несколькими одновременно активными вариантами запрещён.
func validateAction(action object, label string) (string, error) {
	if action == nil {
		return "", fmt.Errorf("%s: ожидался объект перехода", label)
	}
	mode := ""
	for _, kind := range []string{"next", "rewind", "stop", "escalate"} {
		if _, exists := action[kind]; exists {
			if mode != "" {
				return "", fmt.Errorf("%s: нужен ровно один вид перехода", label)
			}
			mode = kind
		}
	}
	if mode == "" {
		return "", fmt.Errorf("%s: нужен ровно один вид перехода", label)
	}
	keys := []string{mode}
	if mode == "rewind" {
		keys = append(keys, "reset")
	}
	if err := exactKeys(action, label, keys...); err != nil {
		return "", err
	}
	switch mode {
	case "next", "rewind":
		if _, err := identifier(action[mode], entityPattern, label+"."+mode); err != nil {
			return "", err
		}
		if mode == "rewind" {
			_, err := uniqueIDs(action["reset"], label+".reset", false)
			return mode, err
		}
	case "stop":
		if !inValues([]string{"human", "failed", "done"}, action["stop"]) {
			return "", fmt.Errorf("%s.stop: неизвестная цель", label)
		}
	case "escalate":
		escalate := objectValue(action["escalate"])
		if err := exactKeys(escalate, label+".escalate", "routes"); err != nil {
			return "", err
		}
		_, err := uniqueIDs(escalate["routes"], label+".escalate.routes", false)
		return mode, err
	}
	return mode, nil
}

// validateArc связывает проверенный переход с узлами текущей машины.
// Эскалация может ссылаться только на маршруты из собственной записи политики.
func (m machineModel) validateArc(id, label, mode string, action object) (string, error) {
	if mode == "escalate" {
		allowed := arrayValue(m.escalation[id]["allowedRoutes"])
		for _, value := range arrayValue(objectValue(action[mode])["routes"]) {
			if !containsValue(allowed, textValue(value)) {
				return "", fmt.Errorf("%s: escalation не объявлена или маршрут не разрешён", label)
			}
		}
		return "", nil
	}
	if mode == "stop" {
		return "", nil
	}
	target := textValue(action[mode])
	position, exists := m.positions[target]
	if !exists {
		return "", fmt.Errorf("%s.%s: цель не исполняется", label, mode)
	}
	source := m.positions[id]
	if mode == "next" {
		if position <= source {
			return "", fmt.Errorf("%s.next: назад можно идти только через rewind", label)
		}
		return target, nil
	}
	if position >= source {
		return "", fmt.Errorf("%s.rewind: цель должна быть раньше", label)
	}
	reset := arrayValue(action["reset"])
	if len(reset) != source-position+1 {
		return "", fmt.Errorf("%s.reset: нужен весь непрерывный участок от цели до текущего узла", label)
	}
	for _, targetID := range m.orderedIDs[position : source+1] {
		if !containsValue(reset, targetID) {
			return "", fmt.Errorf("%s.reset: нужен весь непрерывный участок от цели до текущего узла", label)
		}
	}
	return target, nil
}

// validateReachability проходит только проверенные дуги из entry.
// Изолированный исполняемый узел нельзя закрепить в каталоге.
func (m machineModel) validateReachability(links map[string][]string) error {
	queue := []string{textValue(m.data["entry"])}
	visited := make(map[string]bool)
	for len(queue) != 0 {
		head := queue[0]
		queue = queue[1:]
		if !visited[head] {
			visited[head] = true
			queue = append(queue, links[head]...)
		}
	}
	var missing []string
	for _, id := range m.orderedIDs {
		if !visited[id] {
			missing = append(missing, id)
		}
	}
	if len(missing) != 0 {
		sort.Strings(missing)
		return fmt.Errorf("machine.nodes: недостижимые узлы %s", strings.Join(missing, ", "))
	}
	return nil
}

// validatePromptSet проверяет обратную связь от файлов к объявленным блокам.
// Лишний промпт проходит проверку структуры каталога только при наличии ссылки из узла.
func (m machineModel) validatePromptSet(prompts map[string]string) error {
	known := make(map[string]bool)
	for _, id := range m.orderedIDs {
		for _, raw := range arrayValue(objectValue(m.nodes[id]["prompt"])["blocks"]) {
			known[textValue(objectValue(raw)["file"])] = true
		}
	}
	var unused []string
	for _, name := range sortedKeys(prompts) {
		if !known[name] {
			unused = append(unused, name)
		}
	}
	if len(unused) != 0 {
		return fmt.Errorf("bundle: неиспользуемые prompts %s", strings.Join(unused, ", "))
	}
	return nil
}

// validateLoop проверяет, что рабочая пара обрабатывает продуктовые результаты вместе.
// Автоматический возврат допускается по одной дуге и учитывается отдельным бюджетом.
func (m machineModel) validateLoop() error {
	loop := objectValue(m.data["loop"])
	if err := exactKeys(loop, "machine.loop", "lead", "worker"); err != nil {
		return err
	}
	for _, role := range []string{"lead", "worker"} {
		id, err := identifier(loop[role], entityPattern, "machine.loop."+role)
		if err != nil {
			return err
		}
		node := m.nodes[id]
		if node["executor"] != "agent" || m.phases[id] != "main" {
			return fmt.Errorf("machine.loop.%s: нужен agent-узел фазы main", role)
		}
		if intValue(objectValue(node["retry"])["productFailure"]) != 0 {
			const message = "machine.loop.%s: productFailure должен быть 0 — повтор принадлежит циклу"
			return fmt.Errorf(message, role)
		}
	}
	lead, worker := textValue(loop["lead"]), textValue(loop["worker"])
	if lead == worker {
		return fmt.Errorf("machine.loop: ведущий и исполнитель должны различаться")
	}
	if m.positions[worker]+1 != m.positions[lead] {
		return fmt.Errorf("machine.loop: исполнитель стоит в sequence.main непосредственно перед ведущим")
	}
	if m.data["entry"] != lead {
		return fmt.Errorf("machine.loop: вход маршрута — ведущий")
	}
	if err := m.validateLoopTransfer(lead, worker); err != nil {
		return err
	}
	return m.validateLoopArcs(lead, worker)
}

// validateLoopTransfer подтверждает обработку продуктовых исходов ведущим.
// При отказе ведущего исполнитель получает повторное задание через строго заданный reset.
func (m machineModel) validateLoopTransfer(lead, worker string) error {
	workerNode, leadNode := m.nodes[worker], m.nodes[lead]
	for _, outcome := range []string{"done", "skipped", "failed"} {
		if objectValue(objectValue(workerNode["on"])[outcome])["next"] != lead {
			return fmt.Errorf("machine.loop: исполнитель после %s передаёт работу ведущему", outcome)
		}
	}
	for _, owner := range []string{"build", "tests", "plan", "human"} {
		if effectiveFailure(workerNode, owner)["next"] != lead {
			return fmt.Errorf("machine.loop: отказ исполнителя с owner %s передаёт работу ведущему", owner)
		}
	}
	for _, owner := range []string{"build", "tests"} {
		if !loopTransfer(effectiveFailure(leadNode, owner), lead, worker) {
			return fmt.Errorf("machine.loop: отказ ведущего с owner %s возвращает работу исполнителю", owner)
		}
	}
	if !loopTransfer(objectValue(objectValue(leadNode["on"])["failed"]), lead, worker) {
		return fmt.Errorf("machine.loop: обычный отказ ведущего возвращает работу исполнителю")
	}
	return nil
}

// validateLoopArcs отклоняет автономный вход в исполнителя в обход ведущего.
// Ворота сохраняют человеческое право возврата в рабочую пару.
func (m machineModel) validateLoopArcs(lead, worker string) error {
	if len(m.escalation) != 0 {
		return fmt.Errorf("machine.loop: эскалация маршрута в цикле запрещена")
	}
	for _, id := range m.orderedIDs {
		node := m.nodes[id]
		for _, channel := range []string{"on", "onFailure"} {
			actions := objectValue(node[channel])
			for _, outcome := range sortedKeys(actions) {
				action := objectValue(actions[outcome])
				label := fmt.Sprintf("machine.nodes.%s.%s", id, outcome)
				if channel == "onFailure" {
					label = fmt.Sprintf("machine.nodes.%s.onFailure.%s", id, outcome)
				}
				if action["escalate"] != nil {
					return fmt.Errorf("%s: эскалация маршрута в цикле запрещена", label)
				}
				if node["executor"] == "gate" {
					continue
				}
				if action["rewind"] != nil && (id != lead || !loopTransfer(action, lead, worker)) {
					const message = "%s: в цикле автоматический возврат — только ведущий → исполнитель"
					return fmt.Errorf(message, label)
				}
				if action["next"] == worker {
					return fmt.Errorf("%s: вход в исполнителя в обход ведущего запрещён", label)
				}
			}
		}
	}
	return nil
}

func loopTransfer(action object, lead, worker string) bool {
	reset := arrayValue(action["reset"])
	return action["rewind"] == worker && len(reset) == 2 && reset[0] == worker && reset[1] == lead
}

// effectiveFailure использует owner-specific переход при его наличии.
// Общий failed остаётся источником решения для остальных узлов.
func effectiveFailure(node object, owner string) object {
	if action := objectValue(objectValue(node["onFailure"])[owner]); action != nil {
		return action
	}
	return objectValue(objectValue(node["on"])["failed"])
}

// selectTransition применяет одно правило для редактора и выполнения бандла.
// Политику смены маршрута получает только переход escalate.
func (m machineModel) selectTransition(id, outcome string, failureOwner any) (object, object, error) {
	node := m.nodes[id]
	if node == nil || node["executor"] == "status" {
		return nil, nil, fmt.Errorf("node %s: не является исполняемым", id)
	}
	action := objectValue(objectValue(node["on"])[outcome])
	if action == nil {
		return nil, nil, fmt.Errorf("node %s: outcome %s не описан", id, outcome)
	}
	if failureOwner != nil {
		if outcome != "failed" || !inValues(failureOwners, failureOwner) {
			return nil, nil, fmt.Errorf("failureOwner допустим только для outcome failed")
		}
		action = effectiveFailure(node, textValue(failureOwner))
	}
	if action["escalate"] != nil {
		return action, m.escalation[id], nil
	}
	return action, nil, nil
}

// Transition возвращает решение закреплённого бандла для одного исхода.
// Повтор и выбор владельца читаются из проверенного узла.
func (b MachineBundle) Transition(id, outcome, failureOwner string) (map[string]any, error) {
	var owner any
	if failureOwner != "" {
		if outcome != "failed" || !inValues(failureOwners, failureOwner) {
			return nil, fmt.Errorf("failure-owner допустим только для outcome failed")
		}
		owner = failureOwner
	}
	action, escalation, err := b.model.selectTransition(id, outcome, owner)
	if err != nil {
		return nil, err
	}
	var policy any
	if escalation != nil {
		policy = escalation
	}
	return object{
		"action": action, "escalationPolicy": policy, "retry": b.model.nodes[id]["retry"],
		"node": id, "outcome": outcome,
	}, nil
}

// LaunchTopology вычисляет возможности доставки и инструментирования.
// Обе возможности определяются структурой маршрута, независимо от его имени.
func (b MachineBundle) LaunchTopology() (delivery, instrumentation string) {
	delivery, instrumentation = "disabled", "disabled"
	if b.model.nodes["ship"] != nil {
		delivery = "publish"
	}
	for _, id := range b.model.orderedIDs {
		policy := objectValue(b.model.nodes[id]["policy"])
		if policy["filesystem"] == "transactional-write" {
			if id == "instrument" {
				return delivery, "explicit"
			}
			instrumentation = "derived"
		}
	}
	return delivery, instrumentation
}

// RewindReset возвращает хвост канонического порядка от выбранного узла.
// Административный rewind применим только к существующему main или tail узлу.
func (b MachineBundle) RewindReset(node string) ([]any, error) {
	index := slices.Index(b.model.orderedIDs, node)
	if index < 0 || b.Machine["kind"] != "route" {
		return nil, fmt.Errorf("goto: узел отсутствует в закреплённом маршруте")
	}
	result := make([]any, 0, len(b.model.orderedIDs)-index)
	for _, item := range b.model.orderedIDs[index:] {
		result = append(result, item)
	}
	return result, nil
}
