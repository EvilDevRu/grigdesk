package route

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

const maxContextFile = 256 * 1024

var (
	contextTaskID    = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
	contextAttemptID = regexp.MustCompile(`^a_[a-f0-9]{32}$`)
	contextBranch    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$`)
	contextPort      = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)
	contextHost      = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$`)
	contextURL       = regexp.MustCompile(`^https?://[A-Za-z0-9.:\[\]-]+(/.*)?$`)
	contextResult    = regexp.MustCompile(`^([a-z0-9][a-z0-9_-]{0,40}):([a-z][a-z-]{0,20}):([0-9]{1,6})$`)
	contextRequired  = []string{"task", "profile", "attempt", "catalog-hash", "route", "route-hash",
		"node", "run-key", "ticket-json", "project-context-json", "state-dir", "workspace-mode",
		"container-name", "source-branch"}
	contextRepeated = []string{"repo", "allowed-file", "stage-result", "delivery-action", "delivery-target"}
	contextOptional = []string{"backend-source", "frontend-source", "backend-worktree", "frontend-worktree",
		"frontend-port", "api-port", "service-host", "scope-file", "transaction-id", "instrumentation-phase",
		"diagnosis-kind", "diagnosis-signal", "event-count", "findings-ledger-file", "findings-ledger-json",
		"loop-state-json", "loop-max-rounds", "selected-by", "cause-decision", "cause-comment",
		"review-decision", "review-comment", "acceptance-decision", "acceptance-comment",
		"delivery-strategy", "delivery-mode"}
	contextChoices = map[string][]string{
		"instrumentation-phase": {"not-started", "active", "cleaned", "stalled"},
		"diagnosis-kind":        {"functional", "performance", "data", "integration"},
		"selected-by":           {"human", "scout", "recovery"},
		"cause-decision":        {"pending", "approved", "rejected"},
		"review-decision":       {"pending", "approved", "rejected"},
		"acceptance-decision":   {"pending", "approved", "rejected"},
		"delivery-mode":         {"publish", "disabled"},
		"delivery-strategy":     {"commit", "merge", "pull-request"},
		"delivery-action":       {"commit", "merge", "push", "pull-request", "task-comment"},
	}
)

type contextOptions map[string][]string

func (o contextOptions) value(key string) string {
	if values := o[key]; len(values) != 0 {
		return values[len(values)-1]
	}
	return ""
}

// RunContext сохраняет коды парсера и предметной проверки factory-context.
// Контекст выводится только целиком после валидации всех секций.
func RunContext(args []string, out, diagnostic io.Writer) int {
	options, err := parseContextOptions(args)
	if err != nil {
		fmt.Fprintf(diagnostic, "context v2: %s\n", err)
		return 2
	}
	value, err := options.build()
	if err != nil {
		fmt.Fprintf(diagnostic, "context v2: %s\n", err)
		return 78
	}
	if err := WriteJSON(out, value); err != nil {
		return 1
	}
	return 0
}

// parseContextOptions разбирает только публичные флаги конструктора контекста.
// Списки репозиториев, артефактов и результатов сохраняют исходный порядок.
func parseContextOptions(args []string) (contextOptions, error) {
	options := contextOptions{
		"service-host": {"127.0.0.1"}, "instrumentation-phase": {"not-started"},
		"diagnosis-kind":   {"functional"},
		"diagnosis-signal": {"unspecified"}, "event-count": {"0"}, "selected-by": {"human"},
		"cause-decision": {"pending"}, "review-decision": {"pending"}, "acceptance-decision": {"pending"},
		"delivery-mode": {"publish"},
	}
	for len(args) != 0 {
		arg := args[0]
		args = args[1:]
		if arg == "--instrumentation-required" {
			options["instrumentation-required"] = []string{"true"}
			continue
		}
		name, inline, hasInline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
		repeat := slices.Contains(contextRepeated, name)
		if !strings.HasPrefix(arg, "--") ||
			(!repeat && !slices.Contains(contextRequired, name) && !slices.Contains(contextOptional, name)) {
			return nil, fmt.Errorf("неизвестный аргумент %s", arg)
		}
		value := inline
		if !hasInline {
			if len(args) == 0 || strings.HasPrefix(args[0], "--") {
				return nil, fmt.Errorf("--%s: нужно значение", name)
			}
			value, args = args[0], args[1:]
		}
		if choices := contextChoices[name]; choices != nil && !slices.Contains(choices, value) {
			return nil, fmt.Errorf("--%s: неизвестное значение", name)
		}
		if repeat {
			options[name] = append(options[name], value)
		} else {
			options[name] = []string{value}
		}
	}
	for _, key := range contextRequired {
		if _, exists := options[key]; !exists {
			return nil, fmt.Errorf("нужен --%s", key)
		}
	}
	if _, err := strconv.ParseInt(options.value("event-count"), 10, 64); err != nil {
		return nil, fmt.Errorf("--event-count: ожидалось целое")
	}
	return options, nil
}

// build соединяет только проверенные секции одной попытки.
// Все пути и данные задачи приходят из явных параметров вызывающего кода.
func (o contextOptions) build() (object, error) {
	if err := o.validateIdentity(); err != nil {
		return nil, err
	}
	taskID, node := o.value("task"), o.value("node")
	project, err := o.project()
	if err != nil {
		return nil, err
	}
	workspace, roots, err := o.workspace()
	if err != nil {
		return nil, err
	}
	instrumentation, diagnosis, err := o.instrumentation(textValue(workspace["stateDir"]), roots)
	if err != nil {
		return nil, err
	}
	evidence, artifacts, err := o.evidence(textValue(workspace["stateDir"]), taskID, node)
	if err != nil {
		return nil, err
	}
	task, err := readContextTicket(o.value("ticket-json"), taskID)
	if err != nil {
		return nil, err
	}
	services, err := o.services()
	if err != nil {
		return nil, err
	}
	delivery, err := o.delivery(workspace["repos"].([]string))
	if err != nil {
		return nil, err
	}
	decisions, err := o.decisions()
	if err != nil {
		return nil, err
	}
	return object{
		"task": task, "project": project, "workspace": workspace, "services": services,
		"artifacts": artifacts, "instrumentation": instrumentation, "diagnosis": diagnosis,
		"evidence": evidence, "decisions": decisions, "delivery": delivery,
		"attempt": object{
			"id": o.value("attempt"), "engineProtocol": 2, "catalogHash": o.value("catalog-hash"),
			"routeId": o.value("route"), "routeHash": o.value("route-hash"),
			"selectedBy": o.value("selected-by"),
		},
		"routeCatalog": object{o.value("route"): o.value("route-hash")},
		"stage":        object{"id": node, "runKey": o.value("run-key")},
	}, nil
}

// validateIdentity проверяет служебные идентификаторы до открытия файлов.
// Независимая схема ticket 1 разрешается после подтверждения попытки v2.
func (o contextOptions) validateIdentity() error {
	rules := []struct {
		name    string
		pattern *regexp.Regexp
	}{
		{"task", contextTaskID}, {"profile", profilePattern}, {"attempt", contextAttemptID},
		{"catalog-hash", digestPattern}, {"route", entityPattern}, {"route-hash", digestPattern},
		{"node", entityPattern}, {"run-key", runKeyPattern},
	}
	for _, rule := range rules {
		if _, err := identifier(o.value(rule.name), rule.pattern, rule.name); err != nil {
			return err
		}
	}
	if !inValues([]string{"isolated", "shared"}, o.value("workspace-mode")) {
		return fmt.Errorf("workspace-mode: допускается только isolated или shared")
	}
	return nil
}

// contextText ограничивает длину строк по числу символов.
// Строка с нулевым байтом никогда не попадает в контекст.
func contextText(value any, label string, low, high int) (string, error) {
	text, ok := value.(string)
	size := utf8.RuneCountInString(text)
	if !ok || size < low || size > high || strings.ContainsRune(text, 0) {
		return "", fmt.Errorf("%s: недопустимая строка", label)
	}
	return text, nil
}

// contextTextList сохраняет исходный порядок и проверяет каждый элемент.
// Максимальный размер списка и элемента зависит от секции.
func contextTextList(value any, label string, countLimit, itemLimit int) ([]string, error) {
	values, ok := value.([]any)
	if !ok || len(values) > countLimit {
		return nil, fmt.Errorf("%s: ожидался массив до %d строк", label, countLimit)
	}
	result := make([]string, 0, len(values))
	for index, raw := range values {
		text, err := contextText(raw, fmt.Sprintf("%s[%d]", label, index), 1, itemLimit)
		if err != nil {
			return nil, err
		}
		result = append(result, text)
	}
	return result, nil
}

// project читает объявленные профилем stack и guardrails.
// В секцию не добавляются посторонние поля из JSON-аргумента.
func (o contextOptions) project() (object, error) {
	const label = "project-context-json"
	raw, err := contextText(o.value(label), label, 1, 32768)
	if err != nil {
		return nil, err
	}
	value, err := parseObject([]byte(raw), label)
	if err != nil {
		return nil, err
	}
	if err := exactKeys(value, label, "stack", "guardrails"); err != nil {
		return nil, err
	}
	stack, err := contextTextList(value["stack"], label+".stack", 64, 500)
	if err != nil {
		return nil, err
	}
	if len(stack) == 0 {
		return nil, fmt.Errorf("%s.stack: нужен хотя бы один элемент", label)
	}
	rules, err := contextTextList(value["guardrails"], label+".guardrails", 100, 2000)
	if err != nil {
		return nil, err
	}
	return object{"profile": o.value("profile"), "stack": stack, "guardrails": rules}, nil
}

// readContextFile ограничивает объём чтения и проверяет обычный файл.
// Дескриптор каталога используется для открытия фактического имени.
func readContextFile(path string, limit int64) ([]byte, error) {
	root, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return readRegularLimit(root, filepath.Base(path), limit)
}

// readContextTicket переносит только поля независимого контракта задачи.
// Совпадение taskId проверяется до преобразования идентификатора в JSON-число.
// ValidateContextTicket проверяет тот же immutable ticket до подготовки стенда.
// Формат совпадает с секцией task в публичном factory context.
func ValidateContextTicket(path, task string) error {
	_, err := readContextTicket(path, task)
	return err
}

func readContextTicket(path, task string) (object, error) {
	raw, err := readContextFile(path, maxContextFile)
	if err != nil {
		return nil, fmt.Errorf("ticket: %w", err)
	}
	value, err := parseObject(raw, "ticket")
	if err != nil {
		return nil, err
	}
	fields := []string{"schema", "taskId", "title", "description", "acceptanceCriteria", "sourceUrl"}
	if err := exactKeys(value, "ticket", fields...); err != nil {
		return nil, err
	}
	if value["schema"] != json.Number("1") {
		return nil, fmt.Errorf("ticket.schema: поддерживается только 1")
	}
	storedTask, ok := value["taskId"].(string)
	if !ok {
		number, _ := value["taskId"].(json.Number)
		storedTask = string(number)
	}
	if storedTask != task {
		return nil, fmt.Errorf("ticket.taskId: не совпадает с запуском")
	}
	result := object{"id": json.Number(task)}
	for field, limit := range map[string]int{"title": 500, "description": 100000, "sourceUrl": 2000} {
		text, err := contextText(value[field], "ticket."+field, 1, limit)
		if err != nil {
			return nil, err
		}
		result[field] = text
	}
	if !contextURL.MatchString(textValue(result["sourceUrl"])) {
		return nil, fmt.Errorf("ticket.sourceUrl: нужен http(s) URL")
	}
	criteria, err := contextTextList(value["acceptanceCriteria"], "ticket.acceptanceCriteria", 100, 2000)
	if err != nil {
		return nil, err
	}
	result["acceptanceCriteria"] = criteria
	return result, nil
}

// contextDirectory принимает только физический нормализованный путь каталога.
// Переданные workspace и stateDir не разрешаются через символические ссылки.
func contextDirectory(value, label string) error {
	if !filepath.IsAbs(value) || strings.ContainsAny(value, "\n\t") {
		return fmt.Errorf("%s: нужен абсолютный путь", label)
	}
	if info, err := os.Lstat(value); err != nil || !info.IsDir() || filepath.Clean(value) != value {
		return fmt.Errorf("%s: каталог отсутствует или небезопасен", label)
	}
	resolved, err := filepath.EvalSymlinks(value)
	if err != nil || resolved != value {
		return fmt.Errorf("%s: symlink-компоненты запрещены", label)
	}
	return nil
}

// contextCandidate проверяет будущий файл под одним из разрешённых корней.
// Сам артефакт может ещё отсутствовать, его родитель уже обязан существовать.
func contextCandidate(value, label string, roots []string) error {
	if !filepath.IsAbs(value) || strings.ContainsAny(value, "\n\t") || filepath.Clean(value) != value {
		return fmt.Errorf("%s: нужен нормализованный абсолютный путь", label)
	}
	if err := contextDirectory(filepath.Dir(value), label); err != nil {
		return err
	}
	if info, err := os.Lstat(value); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s: небезопасный объект", label)
	}
	for _, root := range roots {
		if strings.HasPrefix(value, root+string(filepath.Separator)) {
			return nil
		}
	}
	return fmt.Errorf("%s: файл находится вне разрешённых корней", label)
}

// checkContextBranch проверяет ветку Git как данные, без вызова Git.
// Сохраняются исторические ограничения для исходной ветки и веток репозиториев.
func checkContextBranch(value, label string) error {
	if _, err := identifier(value, contextBranch, label); err != nil {
		return err
	}
	if strings.Contains(value, "..") || strings.Contains(value, "//") || strings.Contains(value, "@{") ||
		strings.HasSuffix(value, "/") || strings.HasSuffix(value, ".") || strings.HasSuffix(value, ".lock") {
		return fmt.Errorf("%s: небезопасное имя ветки", label)
	}
	return nil
}

// workspace сохраняет каждую ветку под именем её собственного репозитория.
// Старые поля backend и frontend поддерживают общий source-branch.
func (o contextOptions) workspace() (object, []string, error) {
	result := object{}
	names, paths := []string{}, []string{}
	for index, raw := range o["repo"] {
		label := fmt.Sprintf("repo[%d]", index)
		if _, err := contextText(raw, label, 1, 8192); err != nil {
			return nil, nil, err
		}
		parts := strings.Split(raw, ":")
		if runtime.GOOS == "windows" && (len(parts) == 5 || len(parts) == 6) &&
			len(parts[1]) == 1 && len(parts[3]) == 1 {
			// Две буквы дисков принадлежат путям, а не разделителям полей.
			parts = append([]string{parts[0], parts[1] + ":" + parts[2], parts[3] + ":" + parts[4]}, parts[5:]...)
		}
		if len(parts) != 3 && len(parts) != 4 {
			return nil, nil, fmt.Errorf("%s: ожидался формат имя:worktree:source:branch", label)
		}
		if len(parts) == 3 {
			parts = append(parts, o.value("source-branch"))
		}
		if err := addContextRepo(result, parts[0], parts[1], parts[2], parts[3], label, paths); err != nil {
			return nil, nil, err
		}
		names, paths = append(names, parts[0]), append(paths, parts[1])
	}
	for _, name := range []string{"backend", "frontend"} {
		path, source := o.value(name+"-worktree"), o.value(name+"-source")
		if path == "" && source == "" {
			continue
		}
		if path == "" || source == "" {
			return nil, nil, fmt.Errorf("%s: worktree и source задаются вместе", name)
		}
		branch := o.value("source-branch")
		if err := addContextRepo(result, name, path, source, branch, name, paths); err != nil {
			return nil, nil, err
		}
		names, paths = append(names, name), append(paths, path)
	}
	if len(names) == 0 {
		return nil, nil, fmt.Errorf("нужен хотя бы один репозиторий: --repo имя:worktree:source:branch")
	}
	state := o.value("state-dir")
	if err := contextDirectory(state, "state-dir"); err != nil {
		return nil, nil, err
	}
	container, err := contextText(o.value("container-name"), "container-name", 1, 255)
	if err != nil {
		return nil, nil, err
	}
	result["mode"], result["repos"] = o.value("workspace-mode"), names
	result["stateDir"], result["containerName"] = state, container
	return result, paths, nil
}

// addContextRepo проверяет один scope перед добавлением в рабочее окружение.
// Имя из profile.sh не может заменить поля самого workspace.
func addContextRepo(result object, name, worktree, source, branch, label string, paths []string) error {
	if _, err := identifier(name, profilePattern, label+".name"); err != nil {
		return err
	}
	if inValues([]string{"mode", "generation", "repos", "stateDir", "containerName"}, name) {
		return fmt.Errorf("%s.name: имя %s зарезервировано typed context", label, name)
	}
	if _, exists := result[name]; exists {
		return fmt.Errorf("%s: повтор имени %s", label, name)
	}
	if slices.Contains(paths, worktree) {
		return fmt.Errorf("repo: worktree повторяется у разных репозиториев")
	}
	if err := contextDirectory(worktree, label+".worktree"); err != nil {
		return err
	}
	if err := contextDirectory(source, label+".source"); err != nil {
		return err
	}
	if err := checkContextBranch(branch, label+".branch"); err != nil {
		return err
	}
	result[name] = object{"path": worktree, "sourcePath": source, "branch": branch}
	return nil
}

// instrumentation связывает список scope с путями самой попытки.
// Статус транзакции и маркер относятся к её taskId.
func (o contextOptions) instrumentation(state string, roots []string) (object, object, error) {
	allowed := make([]string, 0, len(o["allowed-file"]))
	for index, path := range o["allowed-file"] {
		if err := contextCandidate(path, fmt.Sprintf("allowed-file[%d]", index), roots); err != nil {
			return nil, nil, err
		}
		if slices.Contains(allowed, path) {
			return nil, nil, fmt.Errorf("allowed-file: повтор пути")
		}
		allowed = append(allowed, path)
	}
	scope, err := contextText(o.value("scope-file"), "scope-file", 0, 4096)
	if err != nil {
		return nil, nil, err
	}
	if scope == "" {
		scope = "not-created"
	} else if err := contextCandidate(scope, "scope-file", []string{state}); err != nil {
		return nil, nil, err
	}
	signal, err := contextText(o.value("diagnosis-signal"), "diagnosis-signal", 1, 200)
	if err != nil {
		return nil, nil, err
	}
	required := o.value("instrumentation-required") == "true"
	mode := "optional"
	if required {
		mode = "required"
	}
	transaction := o.value("transaction-id")
	if transaction == "" {
		transaction = "not-open"
	}
	instrumentation := object{
		"mode": mode, "transactionId": transaction, "marker": "FACTORY-TRACE:t" + o.value("task"),
		"scopeFile": scope, "allowedFiles": allowed, "phase": o.value("instrumentation-phase"),
	}
	diagnosis := object{
		"kind": o.value("diagnosis-kind"), "signal": signal, "instrumentationRequired": required,
	}
	return instrumentation, diagnosis, nil
}

// services строит URL из объявленного имени хоста и отдельно проверенных портов.
// Пустой порт сохраняет прежнее значение unavailable.
func (o contextOptions) services() (object, error) {
	host := o.value("service-host")
	if !contextHost.MatchString(host) {
		return nil, fmt.Errorf("service-host: нужно имя хоста или адрес без схемы, порта и слэшей")
	}
	urls := object{}
	for suffix, field := range map[string]string{"frontend": "frontendUrl", "api": "apiUrl"} {
		name := suffix + "-port"
		value := o.value(name)
		if value == "" {
			urls[field] = "unavailable"
			continue
		}
		if !contextPort.MatchString(value) {
			return nil, fmt.Errorf("%s: недопустимый порт", name)
		}
		port, _ := strconv.Atoi(value)
		if port > 65535 {
			return nil, fmt.Errorf("%s: порт вне диапазона", name)
		}
		urls[field] = "http://" + host + ":" + value
	}
	return urls, nil
}

// decisions сохраняет текст решения человека и его статус в отдельных полях.
// Комментарий ограничен допустимым размером для контекста следующего узла.
func (o contextOptions) decisions() (object, error) {
	result := object{}
	for _, name := range []string{"cause", "review", "acceptance"} {
		comment, err := contextText(o.value(name+"-comment"), "decision comment", 0, 10000)
		if err != nil {
			return nil, err
		}
		result[name] = object{"status": o.value(name + "-decision"), "comment": comment}
	}
	return result, nil
}

// delivery применяет точный opt-in набор действий либо исторический контракт.
// Утверждённые цели обязаны принадлежать текущим закреплённым репозиториям.
func (o contextOptions) delivery(repos []string) (object, error) {
	mode, strategy := o.value("delivery-mode"), o.value("delivery-strategy")
	actions := make([]string, 0, len(o["delivery-action"]))
	for _, name := range o["delivery-action"] {
		if !slices.Contains(actions, name) {
			actions = append(actions, name)
		}
	}
	required := []string{"commit", "push", "pull-request"}
	if strategy == "" {
		if slices.Contains(actions, "merge") {
			return nil, fmt.Errorf("delivery-action: merge требует явную стратегию")
		}
		for _, name := range required {
			if mode == "publish" && !slices.Contains(actions, name) {
				return nil, fmt.Errorf("delivery-action: publish требует commit, push и pull-request")
			}
		}
	} else {
		if err := validateContextDelivery(strategy, mode, o["delivery-action"]); err != nil {
			return nil, err
		}
	}
	targets, err := o.deliveryTargets(mode, repos)
	if err != nil {
		return nil, err
	}
	branch := o.value("source-branch")
	if err := checkContextBranch(branch, "source-branch"); err != nil {
		return nil, err
	}
	result := object{"mode": mode, "actions": actions, "targetBranches": targets, "sourceBranch": branch}
	if strategy != "" {
		result["strategy"] = strategy
	}
	return result, nil
}

// validateContextDelivery проверяет точный набор прав стратегии.
// Повтор действия в opt-in форме сам по себе означает невалидный контракт.
func validateContextDelivery(strategy, mode string, actions []string) error {
	expected := map[string][]string{
		"commit": {"commit"}, "merge": {"commit", "merge"},
		"pull-request": {"commit", "pull-request", "push"},
	}
	copy := slices.Clone(actions)
	slices.Sort(copy)
	if !slices.Equal(copy, expected[strategy]) {
		return fmt.Errorf("неверная стратегия сдачи или набор действий")
	}
	if mode != "publish" {
		return fmt.Errorf("delivery-strategy: требуется publish")
	}
	return nil
}

// deliveryTargets принимает repo=branch после проверки исходной формы.
// Алиасы be/fe разрешены только для исторической пары backend/frontend.
func (o contextOptions) deliveryTargets(mode string, repos []string) (map[string]string, error) {
	targets := make(map[string]string)
	legacy := slices.Contains(repos, "backend") && slices.Contains(repos, "frontend")
	var unknown []string
	for index, arg := range o["delivery-target"] {
		label := fmt.Sprintf("delivery-target[%d]", index)
		repo, branch, ok := strings.Cut(arg, "=")
		if !ok || strings.Contains(branch, "=") {
			return nil, fmt.Errorf("%s: ожидалось repo=branch", label)
		}
		if _, err := identifier(repo, profilePattern, label+".repo"); err != nil {
			return nil, err
		}
		if err := checkContextBranch(branch, label+".branch"); err != nil {
			return nil, err
		}
		if _, exists := targets[repo]; exists {
			return nil, fmt.Errorf("%s: повтор репозитория %s", label, repo)
		}
		targets[repo] = branch
		if !slices.Contains(repos, repo) && !(legacy && (repo == "be" || repo == "fe")) {
			unknown = append(unknown, repo)
		}
	}
	if len(targets) == 0 && mode == "publish" {
		return nil, fmt.Errorf("delivery-target: режим publish требует целевые ветки")
	}
	if len(unknown) > 0 {
		slices.Sort(unknown)
		const message = "delivery-target: репозитории отсутствуют в workspace: %s"
		return nil, fmt.Errorf(message, strings.Join(unknown, ", "))
	}
	return targets, nil
}
