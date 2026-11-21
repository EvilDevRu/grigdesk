package route

import (
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
)

const (
	editorSteps   = 200
	loopSteps     = 1200
	loopMaxRounds = 300
	loopDefault   = 20
)

var (
	counterKeyPattern = regexp.MustCompile(`^[a-zA-Z0-9_:/-]{1,160}$`)
	editorIndex       = regexp.MustCompile(`\[([0-9]+)\]`)
	editorSections    = []string{"task", "attempt", "project", "workspace", "services", "artifacts",
		"diagnosis", "instrumentation", "evidence", "decisions", "delivery", "routeCatalog", "stage"}
)

type editorCatalog struct {
	machines  map[string]machineModel
	bundles   map[string]MachineBundle
	bootstrap machineModel
	scout     MachineBundle
	issues    []object
}

type catalogValidation struct {
	issues []object
}

func (v catalogValidation) Error() string {
	return "черновик каталога не прошёл проверку"
}

// EditorCapabilities выдаёт только декларации чистой модели маршрута.
// Состав native fanout в этой порции сверяется со снимком Bash-адаптеров.
func EditorCapabilities(profile string) (map[string]any, error) {
	if _, err := identifier(profile, profilePattern, "profile"); err != nil {
		return nil, err
	}
	context := make([]object, 0, len(editorSections))
	for _, name := range editorSections {
		context = append(context, object{"id": name, "label": name})
	}
	filesystem := slices.Clone(filesystemPolicies)
	timeouts := slices.Clone(timeoutClasses)
	strategies := slices.Clone(retryStrategies)
	slices.Sort(filesystem)
	slices.Sort(timeouts)
	slices.Sort(strategies)
	return object{
		"schema": 1, "contextSections": context, "filesystem": filesystem, "timeoutClasses": timeouts,
		"retryStrategies": strategies, "nativeFanoutRunners": []string{"claude"},
	}, nil
}

// EditorCheck проверяет полный черновик для новой публикации.
// Адреса ошибок передаются в JSON Pointer, без обращения к current.
func EditorCheck(raw []byte, profile string) (map[string]any, bool) {
	value, err := parseObject(raw, "input")
	if err != nil {
		return object{"ok": false, "issues": []object{{
			"code": "invalid_json", "path": "", "message": err.Error(),
		}}}, false
	}
	catalog, err := loadEditorCatalog(value, profile)
	if err != nil {
		return object{"ok": false, "issues": editorIssues(err)}, false
	}
	return object{"ok": true, "issues": catalog.issues}, true
}

func editorIssues(err error) []object {
	if validation, ok := err.(catalogValidation); ok {
		return validation.issues
	}
	return []object{addressEditorIssue(err.Error(), "", nil)}
}

// loadEditorCatalog проверяет черновик независимо от файлового хранилища.
// Рендер и пробные переходы получают одну и ту же проверенную модель.
func loadEditorCatalog(value object, profile string) (editorCatalog, error) {
	catalog := editorCatalog{
		machines: make(map[string]machineModel), bundles: make(map[string]MachineBundle), issues: []object{},
	}
	if _, err := identifier(profile, profilePattern, "profile"); err != nil {
		return catalog, err
	}
	if err := exactKeys(value, "input", "profile", "routes", "bootstrap", "bootstrapPrompts"); err != nil {
		return catalog, err
	}
	if value["profile"] != profile {
		return catalog, fmt.Errorf("input.profile: профиль не совпадает с аргументом CLI")
	}
	routes := objectValue(value["routes"])
	if len(routes) == 0 || len(routes) > 64 {
		return catalog, fmt.Errorf("input.routes: нужен каталог из 1–64 маршрутов")
	}
	for _, id := range sortedKeys(routes) {
		if err := checkRouteID(id, "routeId"); err != nil {
			return catalog, err
		}
		input := objectValue(routes[id])
		base := "/routes/" + id
		if err := exactKeys(input, "bundle", "route", "prompts"); err != nil {
			return catalog, catalogValidation{[]object{addressEditorIssue(err.Error(), base, nil)}}
		}
		bundle, model, err := editorMachine(
			input["route"], input["prompts"], profile, id, "route", base+"/route")
		if err != nil {
			return catalog, err
		}
		catalog.machines[id] = model
		catalog.bundles[id] = bundle
	}
	var err error
	catalog.scout, catalog.bootstrap, err = editorMachine(
		value["bootstrap"], value["bootstrapPrompts"], profile, "scout", "bootstrap", "/bootstrap")
	if err != nil {
		return catalog, err
	}
	err = catalog.validateReferencesAndRuntime()
	return catalog, err
}

// editorMachine передаёт структуру машины общему валидатору вместе с промптами.
// Новый draft ограничивается строже ранее опубликованных ревизий.
func editorMachine(
	machine, prompts any, profile, id, kind, base string,
) (MachineBundle, machineModel, error) {
	files, err := editorPrompts(objectValue(prompts), kind)
	if err != nil {
		location := strings.TrimSuffix(base, "/route")
		if kind == "bootstrap" {
			location = "/bootstrapPrompts"
		}
		return MachineBundle{}, machineModel{}, catalogValidation{[]object{
			addressEditorIssue(err.Error(), location, nil),
		}}
	}
	bundle := MachineBundle{Machine: objectValue(machine), Prompts: files}
	model, err := validateMachine(bundle, profile, id, kind, false)
	if err != nil {
		issue := addressEditorIssue(err.Error(), base, bundle.Machine)
		return bundle, model, catalogValidation{[]object{issue}}
	}
	return bundle, model, nil
}

// editorPrompts проверяет локальный размер и разрешённые имена в черновике.
// Текст каждого блока передаётся валидатору той же машины.
func editorPrompts(source object, kind string) (map[string]string, error) {
	if source == nil {
		return nil, fmt.Errorf("prompts: ожидался объект")
	}
	files := make(map[string]string, len(source))
	total := 0
	for _, name := range sortedKeys(source) {
		if !strings.HasSuffix(name, ".md") || !safeBundlePath(kind, name) {
			return nil, fmt.Errorf("prompts: небезопасное имя файла")
		}
		text := textValue(source[name])
		if strings.TrimSpace(text) == "" {
			return nil, fmt.Errorf("prompts.%s: пустой текст", name)
		}
		if len(text) > 1024*1024 {
			return nil, fmt.Errorf("prompts.%s: превышен размер файла", name)
		}
		total += len(text)
		files[name] = text
	}
	if total > 8*1024*1024 {
		return nil, fmt.Errorf("prompts: превышен размер bundle")
	}
	return files, nil
}

// addressEditorIssue переводит предметное сообщение в адрес поля JSON.
// Идентификаторы узлов заменяются исходной позицией в массиве черновика.
func addressEditorIssue(message, base string, machine object) object {
	if rest, ok := strings.CutPrefix(message, "bundle: неиспользуемые prompts "); ok {
		file, _, _ := strings.Cut(rest, ", ")
		return object{
			"code":    "prompt_unused",
			"path":    strings.TrimSuffix(base, "/route") + "/prompts/" + escapePointer(file),
			"message": message,
		}
	}
	label, _, _ := strings.Cut(message, ":")
	suffix := ""
	if path, ok := strings.CutPrefix(label, "machine."); ok {
		suffix = path
	} else if strings.HasPrefix(label, "prompts.") {
		suffix = label
	}
	parts := []string{}
	if suffix != "" {
		parts = strings.Split(editorIndex.ReplaceAllString(suffix, ".$1"), ".")
	}
	if len(parts) > 1 && parts[0] == "nodes" && machine != nil {
		for index, raw := range arrayValue(machine["nodes"]) {
			if objectValue(raw)["id"] == parts[1] {
				parts[1] = fmt.Sprint(index)
				break
			}
		}
	}
	code := "route_schema_invalid"
	if len(parts) >= 2 && slices.Equal(parts[len(parts)-2:], []string{"retry", "productFailure"}) {
		code = "product_failure_rewind"
	} else if len(parts) != 0 && parts[len(parts)-1] == "reset" && strings.Contains(message, "участок") {
		code = "rewind_reset_invalid"
	}
	for _, part := range parts {
		base += "/" + escapePointer(part)
	}
	return object{"code": code, "path": base, "message": message}
}

func escapePointer(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}

// validateReferencesAndRuntime собирает замечания по всем проверенным машинам.
// Структурные ошибки блокируют черновик, предупреждение о цикле сохраняется в ответе.
func (c *editorCatalog) validateReferencesAndRuntime() error {
	references, runtimeIssues := []object{}, []object{}
	for _, id := range sortedKeys(c.machines) {
		base := "/routes/" + id + "/route"
		model := c.machines[id]
		references = append(references, c.referenceIssues(model, base)...)
		runtimeIssues = append(runtimeIssues, model.runtimeIssues(base)...)
	}
	references = append(references, c.referenceIssues(c.bootstrap, "/bootstrap")...)
	runtimeIssues = append(runtimeIssues, c.bootstrap.runtimeIssues("/bootstrap")...)
	c.issues = append(references, runtimeIssues...)
	for _, issue := range c.issues {
		if issue["severity"] != "warning" {
			return catalogValidation{c.issues}
		}
	}
	return nil
}

// referenceIssues сообщает о каждой отсутствующей цели с точным адресом.
// Учитываются и общие исходы, и переходы, выбранные failure owner.
func (c editorCatalog) referenceIssues(model machineModel, base string) []object {
	var issues []object
	for index, raw := range arrayValue(model.data["nodes"]) {
		node := objectValue(raw)
		for _, channel := range []string{"on", "onFailure"} {
			transitions := objectValue(node[channel])
			for _, outcome := range sortedKeys(transitions) {
				transition := objectValue(transitions[outcome])
				path := fmt.Sprintf("%s/nodes/%d/%s/%s/escalate/routes", base, index, channel, outcome)
				targets := arrayValue(objectValue(transition["escalate"])["routes"])
				issues = append(issues, c.missingTargets(targets, path)...)
			}
		}
	}
	for index, raw := range arrayValue(model.data["escalation"]) {
		path := fmt.Sprintf("%s/escalation/%d/allowedRoutes", base, index)
		issues = append(issues, c.missingTargets(arrayValue(objectValue(raw)["allowedRoutes"]), path)...)
	}
	return issues
}

// missingTargets сравнивает ссылки с маршрутами редактируемого каталога.
// Позиция сохраняется даже при нескольких отсутствующих целях в одном переходе.
func (c editorCatalog) missingTargets(items []any, path string) []object {
	var result []object
	for index, raw := range items {
		id := textValue(raw)
		if _, exists := c.machines[id]; !exists {
			result = append(result, object{
				"code": "route_reference_missing", "path": fmt.Sprintf("%s/%d", path, index),
				"message": fmt.Sprintf("Маршрут %s отсутствует в каталоге", id),
			})
		}
	}
	return result
}

// runtimeIssues применяет ограничения выполнения для новой публикации.
// Исторический immutable reader сохраняет отдельно поля прежнего выпуска.
func (m machineModel) runtimeIssues(base string) []object {
	result := m.instrumentationIssues(base)
	for index, raw := range arrayValue(m.data["nodes"]) {
		node := objectValue(raw)
		failure := objectValue(objectValue(node["retry"])["providerFailure"])
		if failure["strategy"] == "same-runner" {
			result = append(result, object{
				"code":    "retry_strategy_unsupported",
				"path":    fmt.Sprintf("%s/nodes/%d/retry/providerFailure/strategy", base, index),
				"message": "Стратегия same-runner не реализована движком",
			})
		}
	}
	if index := m.firstClosedCycle(); index >= 0 {
		result = append(result, object{
			"code": "runtime_limited_cycle", "severity": "warning",
			"path":    fmt.Sprintf("%s/nodes/%d", base, index),
			"message": "Из этого цикла нет stop/escalate; завершение возможно только по лимитам runtime",
		})
	}
	return result
}

// instrumentationIssues требует пару instrument → proof и проверяет входы.
// Внутренний переход допустим только после открытия транзакции.
func (m machineModel) instrumentationIssues(base string) []object {
	instrument, proof := m.nodes["instrument"], m.nodes["proof"]
	if instrument == nil && proof == nil {
		return nil
	}
	first, hasFirst := m.positions["instrument"]
	last, hasLast := m.positions["proof"]
	if !hasFirst || !hasLast || first >= last ||
		objectValue(instrument["policy"])["filesystem"] != "transactional-write" ||
		objectValue(proof["policy"])["filesystem"] != "transactional-write" {
		return []object{{
			"code": "instrumentation_pair_invalid", "path": base + "/sequence",
			"message": "Для инструментации нужны transactional-write instrument → proof; " +
				"scope задаётся при запуске",
		}}
	}
	var result []object
	for index, raw := range arrayValue(m.data["nodes"]) {
		node := objectValue(raw)
		if node["executor"] == "status" {
			continue
		}
		source := m.positions[textValue(node["id"])]
		for _, channel := range []string{"on", "onFailure"} {
			transitions := objectValue(node[channel])
			for _, outcome := range sortedKeys(transitions) {
				target := transitionTarget(objectValue(transitions[outcome]))
				destination, exists := m.positions[target]
				if exists && first < destination && destination <= last &&
					(source < first || source >= last) {
					result = append(result, object{
						"code":    "instrumentation_zone_unreachable",
						"path":    fmt.Sprintf("%s/nodes/%d/%s/%s", base, index, channel, outcome),
						"message": "Переход попадает в зону instrument → proof без активной транзакции",
					})
				}
			}
		}
	}
	return result
}

// firstClosedCycle распространяет достижимость terminal по обратным дугам.
// Первый недостижимый узел определяет адрес предупреждения в редакторе.
func (m machineModel) firstClosedCycle() int {
	terminal := make(map[string]bool)
	var queue []string
	incoming := make(map[string][]string)
	for _, id := range m.orderedIDs {
		node := m.nodes[id]
		for _, channel := range []string{"on", "onFailure"} {
			for _, raw := range objectValue(node[channel]) {
				action := objectValue(raw)
				if !terminal[id] && (action["stop"] != nil || action["escalate"] != nil) {
					terminal[id] = true
					queue = append(queue, id)
				}
				if target := transitionTarget(action); target != "" {
					incoming[target] = append(incoming[target], id)
				}
			}
		}
	}
	for len(queue) != 0 {
		target := queue[0]
		queue = queue[1:]
		for _, source := range incoming[target] {
			if !terminal[source] {
				terminal[source] = true
				queue = append(queue, source)
			}
		}
	}
	for index, raw := range arrayValue(m.data["nodes"]) {
		node := objectValue(raw)
		if node["executor"] != "status" && !terminal[textValue(node["id"])] {
			return index
		}
	}
	return -1
}

func transitionTarget(action object) string {
	if next := textValue(action["next"]); next != "" {
		return next
	}
	return textValue(action["rewind"])
}

type editorStep struct {
	model      machineModel
	node       object
	cursor     object
	counters   map[string]map[string]int
	catalog    editorCatalog
	request    object
	key        string
	countLimit int
}

// EditorStep вычисляет чистый пробный переход по входному JSON.
// Ошибки идут в протокольный ответ вместе с verdict, без доступа к состоянию попытки.
func EditorStep(raw []byte, profile string) (map[string]any, bool) {
	value, err := parseObject(raw, "input")
	if err != nil {
		return simulationError(err)
	}
	step, err := loadEditorStep(value, profile)
	if err != nil {
		if validation, ok := err.(catalogValidation); ok {
			return object{"ok": false, "issues": validation.issues}, false
		}
		return simulationError(err)
	}
	result, err := step.evaluate()
	if err != nil {
		return simulationError(err)
	}
	return result, true
}

func simulationError(err error) (object, bool) {
	return object{"ok": false, "issues": []object{{
		"code": "simulation_invalid", "path": "", "message": err.Error(),
	}}}, false
}

// loadEditorStep проверяет курсор, бюджеты и каталог до выбора исхода.
// Незавершённый курсор относится к одному узлу проверенной модели.
func loadEditorStep(value object, profile string) (editorStep, error) {
	state := editorStep{request: value, counters: make(map[string]map[string]int)}
	required := []string{"catalogInput", "cursor", "counters", "outcome", "failureOwner",
		"selectedRouteId", "pinned", "stepIndex"}
	if err := optionalKeys(value, "input", required, []string{"humanApproved", "loopMaxRounds"}); err != nil {
		return state, err
	}
	if _, err := intRange(value["stepIndex"], 1, loopSteps, "stepIndex"); err != nil {
		return state, err
	}
	state.countLimit = loopDefault
	if explicit, present := value["loopMaxRounds"]; present {
		limit, err := intRange(explicit, 1, loopMaxRounds, "loopMaxRounds")
		if err != nil {
			return state, err
		}
		state.countLimit = limit
	}
	state.cursor = objectValue(value["cursor"])
	routeID, nodeID, err := validateEditorCursor(state.cursor)
	if err != nil {
		return state, err
	}
	if err := state.readCounters(objectValue(value["counters"])); err != nil {
		return state, err
	}
	if err := validateEditorDecision(value); err != nil {
		return state, err
	}
	state.catalog, err = loadEditorCatalog(objectValue(value["catalogInput"]), profile)
	if err != nil {
		return state, err
	}
	state.model = state.catalog.bootstrap
	if routeID != "" {
		if model, exists := state.catalog.machines[routeID]; exists {
			state.model = model
		} else {
			return state, fmt.Errorf("cursor.routeId: маршрут отсутствует")
		}
	}
	if state.model.data["loop"] == nil {
		if _, err := intRange(value["stepIndex"], 1, editorSteps, "stepIndex"); err != nil {
			return state, err
		}
	}
	state.node = state.model.nodes[nodeID]
	if state.node == nil || state.node["executor"] == "status" {
		return state, fmt.Errorf("cursor.nodeId: узел не исполняется")
	}
	if routeID == "" {
		routeID = "bootstrap"
	}
	state.key = routeID + "/" + nodeID
	return state, nil
}

// validateEditorCursor сохраняет отдельный адрес bootstrap и основного маршрута.
// Терминальный курсор невозможно использовать как вход следующего шага.
func validateEditorCursor(cursor object) (routeID, nodeID string, err error) {
	if err := exactKeys(cursor, "cursor", "scope", "routeId", "nodeId", "terminal"); err != nil {
		return "", "", err
	}
	if cursor["terminal"] != false {
		return "", "", fmt.Errorf("cursor: терминальный сценарий нельзя продолжать")
	}
	if cursor["scope"] != "route" && cursor["scope"] != "bootstrap" {
		return "", "", fmt.Errorf("cursor.scope: неизвестная область")
	}
	nodeID, err = identifier(cursor["nodeId"], entityPattern, "cursor.nodeId")
	if err != nil {
		return "", "", err
	}
	if cursor["scope"] == "bootstrap" {
		if cursor["routeId"] != nil {
			return "", "", fmt.Errorf("cursor.routeId: bootstrap не имеет маршрута")
		}
		return "", nodeID, nil
	}
	routeID = textValue(cursor["routeId"])
	return routeID, nodeID, checkRouteID(routeID, "cursor.routeId")
}

// readCounters загружает только счётчики известных видов и ограниченных ключей.
// Вычисление перехода затем работает с собственной изменяемой копией.
func (s editorStep) readCounters(value object) error {
	keys := []string{"noResult", "productFailure", "rewinds"}
	if err := exactKeys(value, "counters", keys...); err != nil {
		return err
	}
	for _, key := range keys {
		values := objectValue(value[key])
		label := "counters." + key
		if values == nil {
			return fmt.Errorf("%s: ожидалась карта счётчиков", label)
		}
		counters := make(map[string]int, len(values))
		for _, name := range sortedKeys(values) {
			if !counterKeyPattern.MatchString(name) {
				return fmt.Errorf("%s: недопустимый ключ", label)
			}
			number, err := intRange(values[name], 0, loopMaxRounds, label+"."+name)
			if err != nil {
				return err
			}
			counters[name] = number
		}
		s.counters[key] = counters
	}
	return nil
}

// validateEditorDecision сверяет только форму пользовательского выбора.
// Принадлежность выбранного маршрута проверяется после выбора дуги.
func validateEditorDecision(value object) error {
	if _, ok := value["pinned"].(bool); !ok {
		return fmt.Errorf("pinned: ожидался boolean")
	}
	if raw, exists := value["humanApproved"]; exists {
		if _, ok := raw.(bool); !ok {
			return fmt.Errorf("humanApproved: ожидался boolean")
		}
	}
	if value["selectedRouteId"] != nil {
		return checkRouteID(textValue(value["selectedRouteId"]), "selectedRouteId")
	}
	return nil
}

// evaluate сначала расходует повтор на текущем визите, затем применяет дугу.
// При открытии следующего визита бюджеты попытки узла сбрасываются.
func (s editorStep) evaluate() (object, error) {
	result := object{
		"ok": true, "cursor": maps.Clone(s.cursor), "counters": s.counters, "reset": []string{},
		"stop": nil, "escalation": nil, "requiresHuman": false, "issues": s.catalog.issues,
	}
	outcome := textValue(s.request["outcome"])
	if s.request["failureOwner"] != nil && outcome != "failed" {
		return nil, fmt.Errorf("failureOwner допустим только для outcome failed")
	}
	retry := objectValue(s.node["retry"])
	switch outcome {
	case "noResult":
		if s.node["executor"] != "agent" {
			return nil, fmt.Errorf("noResult доступен только для agent-узла")
		}
		budget := intValue(retry["noResult"]) + intValue(objectValue(retry["providerFailure"])["attempts"])
		if s.consumeRetry("noResult", budget, result) {
			return result, nil
		}
		outcome = "exhausted"
	case "failed":
		if s.consumeRetry("productFailure", intValue(retry["productFailure"]), result) {
			return result, nil
		}
	}
	node := textValue(s.node["id"])
	action, policy, err := s.model.selectTransition(node, outcome, s.request["failureOwner"])
	if err != nil {
		return nil, err
	}
	delete(s.counters["noResult"], s.key)
	delete(s.counters["productFailure"], s.key)
	result["action"] = action
	if err := s.applyTransition(result, action, policy); err != nil {
		return nil, err
	}
	return result, nil
}

// consumeRetry отмечает повтор внутри одного визита и удерживает курсор.
// Исчерпанный бюджет оставляет выбор следующего действия обработчику дуги.
func (s editorStep) consumeRetry(kind string, budget int, result object) bool {
	table := s.counters[kind]
	if table[s.key] >= budget {
		return false
	}
	table[s.key]++
	result["action"] = object{"retry": kind}
	return true
}

// applyTransition вычисляет только изменение курсора и сводку редактора.
// Выбор маршрута при закреплении может остаться на решении человека.
func (s editorStep) applyTransition(result, action, policy object) error {
	cursor := objectValue(result["cursor"])
	switch {
	case action["next"] != nil:
		cursor["nodeId"] = action["next"]
	case action["rewind"] != nil:
		s.applyRewind(result, cursor, action)
	case action["stop"] != nil:
		result["stop"] = action["stop"]
		cursor["terminal"] = true
	case action["escalate"] != nil:
		return s.applyEscalation(result, action, policy)
	}
	return nil
}

// applyRewind считает обычный возврат и рабочий круг по разным ограничениям.
// Превышение бюджета завершает текущий курсор без сброса пройденных узлов.
func (s editorStep) applyRewind(result, cursor, action object) {
	target := textValue(action["rewind"])
	arc := s.key + ":" + target
	routeID, _, _ := strings.Cut(s.key, "/")
	targetKey := "target:" + routeID + "/" + target
	counts := s.counters["rewinds"]
	isGate := s.node["executor"] == "gate"
	loop := objectValue(s.model.data["loop"])
	inLoop := loop != nil && loop["lead"] == s.node["id"] && loop["worker"] == target
	hardLimit := 2
	if s.request["failureOwner"] != nil {
		hardLimit = 6
	}
	stop := ""
	switch {
	case inLoop && counts[targetKey] >= s.countLimit:
		stop = "loop-ceiling"
	case !inLoop && !isGate && (counts[arc] >= hardLimit || counts[targetKey] >= 10):
		stop = "rewind-limit"
	}
	if stop != "" {
		result["stop"] = stop
		cursor["terminal"] = true
		return
	}
	cursor["nodeId"] = target
	result["reset"] = action["reset"]
	counts[arc]++
	if !isGate {
		counts[targetKey]++
	}
}

// applyEscalation сохраняет список допустимых маршрутов и проверяет решение.
// Согласованный переход открывает entry выбранной машины.
func (s editorStep) applyEscalation(result, action, policy object) error {
	targets := arrayValue(objectValue(action["escalate"])["routes"])
	result["escalation"] = targets
	target := textValue(s.request["selectedRouteId"])
	if target == "" {
		result["requiresHuman"] = true
		return nil
	}
	if !containsValue(targets, target) || (policy != nil &&
		!containsValue(arrayValue(policy["allowedRoutes"]), target)) {
		return fmt.Errorf("selectedRouteId: маршрут не разрешён переходом")
	}
	if s.request["pinned"] == true && policy["requiresHumanWhenPinned"] == true &&
		s.request["humanApproved"] != true {
		result["requiresHuman"] = true
		return nil
	}
	model, exists := s.catalog.machines[target]
	if !exists {
		return fmt.Errorf("selectedRouteId: маршрут отсутствует")
	}
	result["cursor"] = object{
		"scope": "route", "routeId": target, "nodeId": model.data["entry"], "terminal": false,
	}
	return nil
}
