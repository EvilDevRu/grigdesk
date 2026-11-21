package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"unicode/utf8"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
)

type request struct {
	mode    string
	task    string
	options map[string][]string
}

type optionSpec struct {
	expected string
	once     bool
	repeat   bool
}

const requiredMode = "укажи check, start, resume, gate, abandon, recover, goto или work-time/findings-export"

var (
	profileName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,40}$`)
	taskID      = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
	attemptID   = regexp.MustCompile(`^a_[a-f0-9]{32}$`)
	nodeID      = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,40}$`)
	bootstrapID = regexp.MustCompile(`^b_[a-f0-9]{32}$`)
	sha256Hex   = regexp.MustCompile(`^[a-f0-9]{64}$`)
	stageCAS    = regexp.MustCompile(`^(0|[1-9][0-9]{0,11}):[a-f0-9]{64}$`)
	dispatchID  = regexp.MustCompile(
		`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	runnerID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
)

var options = map[string]optionSpec{
	"--profile":                      {expected: "нужно значение"},
	"--route":                        {expected: "нужно значение"},
	"--routes-dir":                   {expected: "нужен путь"},
	"--state-dir":                    {expected: "нужен путь"},
	"--control-dir":                  {expected: "нужен путь"},
	"--ticket-json":                  {expected: "нужен путь"},
	"--attempt":                      {expected: "нужен id", once: true},
	"--require-host-runtime-context": {once: true},
	"--confirm-manual-restore":       {},
	"--expected-cleanup":             {expected: "нужен SHA-256", once: true},
	"--expected-stage":               {expected: "нужен sequence:sha256", once: true},
	"--reason":                       {expected: "нужен текст", once: true},
	"--actor":                        {expected: "нужен идентификатор", once: true},
	"--diagnosis-kind":               {expected: "нужно значение"},
	"--diagnosis-signal":             {expected: "нужен текст"},
	"--runner-primary":               {expected: "нужен id исполнителя", once: true},
	"--expected-catalog-hash":        {expected: "нужен sha256", once: true},
	"--queue-dispatch-id":            {expected: "нужен UUID", once: true},
	"--node":                         {expected: "нужен gate id", once: true},
	"--decision":                     {expected: "нужно approved|rejected"},
	"--comment":                      {expected: "нужен текст"},
	"--commit-only":                  {},
	"--hold-start":                   {},
	"--instrumentation-file":         {expected: "нужен repo:path", repeat: true},
	"--backend-base":                 {expected: "нужен commit/ref"},
	"--frontend-base":                {expected: "нужен commit/ref"},
	"--delivery-target":              {expected: "нужен repo=branch", repeat: true},
	"--task-comment":                 {},
	"--format":                       {expected: "нужно значение"},
	"--visit":                        {expected: "нужно значение"},
	"--stop-hash":                    {expected: "нужно значение"},
	"--answer-file":                  {expected: "нужно значение"},
}

func (r request) value(name string) string {
	return firstNonempty(r.options[name]...)
}

// has проверяет переданные опции, сохраняя семантику пустых скалярных значений.
// У списков важен сам факт передачи аргумента, у флагов значением служит 1.
func (r request) has(names ...string) bool {
	for _, name := range names {
		if r.value(name) != "" || (options[name].repeat && len(r.options[name]) != 0) {
			return true
		}
	}
	return false
}

// firstNonempty применяет прежний приоритет аргумента, окружения и значения по умолчанию.
// Пустая строка позволяет продолжить выбор следующего источника.
func firstNonempty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// stateDir сохраняет приоритет путей для текущих вызовов из GrigDesk и shell worker.
// HOME используется только при отсутствии обоих исторических override.
func (r request) stateDir() string {
	home := firstNonempty(os.Getenv("HOME"), "/nonexistent")
	return firstNonempty(r.value("--state-dir"), os.Getenv("STATE_DIR"), os.Getenv("FACTORY_STATE"),
		filepath.Join(home, ".factory", "state"))
}

// routesDir разрешает каталог публикации по прежнему пути CLI.
// Каталог будет открыт только после завершения разбора опций и имени проекта.
func (r request) routesDir() string {
	home := firstNonempty(os.Getenv("HOME"), "/nonexistent")
	return firstNonempty(r.value("--routes-dir"), filepath.Join(home, ".factory", "routes"))
}

// parseRequest узнаёт публичные команды и разбирает флаги до обращения к файлам.
// Прежний CLI принимал TASK и действие в произвольном порядке среди опций.
func parseRequest(args []string) (request, error) {
	r := request{options: make(map[string][]string)}
	if len(args) == 0 {
		return r, errors.New(requiredMode)
	}
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return r, errors.New("list не принимает аргументы")
		}
		r.mode = args[0]
		return r, nil
	case "slots":
		if len(args) != 3 || args[1] != "--profile" || !profileName.MatchString(args[2]) {
			return r, errors.New("использование: factory slots --profile PROFILE")
		}
		r.mode = args[0]
		r.options["--profile"] = []string{args[2]}
		return r, nil
	case "runners", "profile", "settings":
		r.mode = args[0]
		return r, nil
	}
	if len(args) > 1 && (args[1] == "runner" || args[1] == "model" || args[1] == "debug") {
		r.mode, r.task = args[1], args[0]
		if !taskID.MatchString(r.task) {
			return r, errors.New("нужен положительный TASK")
		}
		return r, nil
	}

	for len(args) > 0 {
		arg := args[0]
		args = args[1:]
		switch arg {
		case "check", "start", "resume", "gate", "goto", "abandon", "recover", "stop-cleanup",
			"work-time", "findings-export", "bootstrap-answer", "lifecycle-read":
			if r.mode != "" {
				return r, errors.New("режим указан повторно")
			}
			r.mode = arg
		case "--help", "-h":
			r.mode = "help"
			return r, nil
		default:
			if r.task == "" && taskID.MatchString(arg) {
				r.task = arg
				continue
			}
			var err error
			args, err = r.readOption(arg, args)
			if err != nil {
				return r, err
			}
		}
	}

	return r, r.validateOptions()
}

// readOption различает флаг, скаляр и повторяемые параметры.
// Это сохраняет порядок scope/delivery и адресует ошибки до обращения к профилю.
func (r request) readOption(arg string, rest []string) ([]string, error) {
	if arg == "--gate" {
		arg = "--node"
	}
	spec, valid := options[arg]
	if !valid {
		return rest, fmt.Errorf("неизвестный аргумент: %s", arg)
	}
	value := "1"
	if spec.expected != "" {
		if len(rest) == 0 {
			return rest, fmt.Errorf("после %s %s", arg, spec.expected)
		}
		value, rest = rest[0], rest[1:]
	}
	if spec.once && r.has(arg) {
		switch arg {
		case "--node":
			return rest, errors.New("gate id указан повторно")
		case "--expected-cleanup":
			return rest, errors.New("неверный --expected-cleanup")
		case "--require-host-runtime-context":
			return rest, errors.New("недопустимый host runtime context")
		default:
			return rest, fmt.Errorf("%s указан повторно", arg)
		}
	}
	if spec.repeat {
		r.options[arg] = append(r.options[arg], value)
	} else {
		r.options[arg] = []string{value}
	}
	return rest, nil
}

// validateOptions проверяет область применения флагов и имена до чтения путей.
// Диагностики для dispatch, host и CAS используются вызывающим сервером.
func (r request) validateOptions() error {
	if r.mode == "" {
		return errors.New(requiredMode)
	}
	if r.mode == "lifecycle-read" {
		if len(r.options) != 2 || !taskID.MatchString(r.task) ||
			!attemptID.MatchString(r.value("--attempt")) || !filepath.IsAbs(r.value("--control-dir")) {
			return errors.New("lifecycle-read требует TASK, --attempt и абсолютный --control-dir")
		}
		return nil
	}
	if value := r.value("--expected-stage"); value != "" {
		if (r.mode != "gate" && r.mode != "goto") || !stageCAS.MatchString(value) {
			return errors.New("--expected-stage допустим только у gate и goto, формат sequence:sha256")
		}
	}
	if r.mode != "start" && r.has("--runner-primary") {
		return errors.New("--runner-primary допустим только при start")
	}
	if r.mode != "start" && r.has("--hold-start") {
		return errors.New("--hold-start допустим только при start")
	}
	if r.has("--require-host-runtime-context") && runtime.GOOS != "darwin" {
		return errors.New("недопустимый host runtime context")
	}
	if value, passed := r.options["--expected-cleanup"]; passed && !sha256Hex.MatchString(value[0]) {
		return errors.New("неверный --expected-cleanup")
	}
	if r.mode != "stop-cleanup" && r.has("--confirm-manual-restore", "--expected-cleanup") {
		return errors.New("параметры завершения очистки допустимы только при stop-cleanup")
	}
	if err := r.validateCatalogPins(); err != nil {
		return err
	}
	if profile := r.value("--profile"); !(r.mode == "work-time" && profile == "") &&
		!profileName.MatchString(profile) {
		return errors.New("нужен --profile (движок не знает проектов)")
	}
	if route := r.value("--route"); route != "" && !profileName.MatchString(route) {
		return errors.New("route: недопустимое имя (маршрут валидируется по current-каталогу)")
	}

	return nil
}

// validateCatalogPins удерживает queue-dispatch внутри проверенного старта.
// UUID без закреплённого каталога не представляет допустимый запрос пуска.
func (r request) validateCatalogPins() error {
	catalog := r.value("--expected-catalog-hash")
	dispatch := r.value("--queue-dispatch-id")
	switch {
	case catalog != "" && r.mode != "check" && r.mode != "start":
		return errors.New("--expected-catalog-hash допустим только при check или start")
	case dispatch != "" && r.mode != "start":
		return errors.New("--queue-dispatch-id допустим только при start")
	case catalog != "" && !sha256Hex.MatchString(catalog):
		return errors.New("expected-catalog-hash: нужен sha256 в нижнем регистре")
	case dispatch != "" && !dispatchID.MatchString(dispatch):
		return errors.New("queue-dispatch-id: нужен UUID в нижнем регистре")
	case dispatch != "" && catalog == "":
		return errors.New("--queue-dispatch-id требует --expected-catalog-hash")
	default:
		return nil
	}
}

// checkRoutesDirectory проверяет физический каталог перед доступом к профильным декларациям.
// Ни каталог маршрутов, ни каталоги состояния на этапе admission не создаются.
func checkRoutesDirectory(dir string) error {
	if !filepath.IsAbs(dir) || strings.ContainsAny(dir, "\n\t") {
		return errors.New("routes-dir: нужен существующий абсолютный каталог без symlink")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		return errors.New("routes-dir: нужен существующий абсолютный каталог без symlink")
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return errors.New("routes-dir: путь не разрешается")
	}
	if resolved != dir || dir == string(filepath.Separator) {
		return errors.New("routes-dir: путь должен быть каноническим и не корневым")
	}
	return nil
}

// admit проверяет границу поколения до любой загрузки Bash или создания попытки.
// Служебные операции чтения sealed attempt не зависят от текущего профиля.
func (r request) admit() error {
	if err := checkRoutesDirectory(r.routesDir()); err != nil {
		return err
	}
	switch r.mode {
	case "bootstrap-answer":
		return r.validateBootstrapAnswer()
	case "findings-export":
		return r.validateFindingsExport()
	}
	if r.has("--visit", "--stop-hash", "--answer-file") {
		return errors.New("visit, stop-hash и answer-file допустимы только для bootstrap-answer")
	}
	if r.has("--format") {
		return errors.New("--format допустим только для findings-export")
	}

	profile := r.value("--profile")
	script, graph, runners := hooks.ProfileFiles(profile)
	if err := hooks.CheckFile(script, "profile"); err != nil {
		return err
	}
	if err := hooks.CheckFile(runners, "runners-config"); err != nil {
		return err
	}
	if err := hooks.RequireRouteV2(graph, profile); err != nil {
		return err
	}
	if _, err := hooks.RunnerConfig(runners); err != nil {
		return err
	}

	if r.mode == "check" {
		return r.validateCheck()
	}
	if os.Getenv("FACTORY_FORBID_LIVE") == "1" {
		return errors.New("live lifecycle запрещён текущим окружением")
	}
	if !taskID.MatchString(r.task) {
		return errors.New("нужен положительный TASK")
	}
	if r.mode == "start" {
		return r.validateStart()
	}
	return r.validateAttemptAction()
}

// validateCheck сохраняет Linux-форму без задачи и Darwin-форму открытой попытки.
// Darwin получает exact task+attempt и отклоняет смешивание с новым маршрутом.
func (r request) validateCheck() error {
	if runtime.GOOS != "darwin" {
		if r.task != "" || r.has("--attempt", "--ticket-json") {
			return errors.New("check не принимает task, attempt или ticket")
		}
		return nil
	}
	if r.has("--ticket-json") {
		return errors.New("check не принимает ticket")
	}
	if r.task != "" || r.has("--attempt") {
		if !taskID.MatchString(r.task) || !attemptID.MatchString(r.value("--attempt")) || r.has("--route") {
			return errors.New("проверка попытки требует exact task и attempt")
		}
	}
	return nil
}

// validateStart принимает параметры новой попытки после проверки capability.
// Ограничения от topology маршрута применяются после чтения закреплённого каталога.
func (r request) validateStart() error {
	if !r.has("--route") {
		return errors.New("start требует --route")
	}
	if !r.has("--ticket-json") {
		return errors.New("start требует --ticket-json")
	}
	if err := hooks.CheckFile(r.value("--ticket-json"), "ticket-json"); err != nil {
		return err
	}
	if r.has("--attempt", "--node", "--decision") {
		return errors.New("start не принимает attempt или gate decision")
	}
	switch r.value("--diagnosis-kind") {
	case "", "functional", "performance", "data", "integration":
	default:
		return errors.New("diagnosis-kind: functional|performance|data|integration")
	}
	signal := r.value("--diagnosis-signal")
	if utf8.RuneCountInString(signal) > 200 || strings.ContainsAny(signal, "\n\t") {
		return errors.New("diagnosis-signal: до 200 символов одной строкой")
	}
	if id := r.value("--runner-primary"); id != "" && !runnerID.MatchString(id) {
		return errors.New("runner-primary: недопустимый id исполнителя")
	}
	if r.has("--reason") {
		return errors.New("--reason допустим только в abandon, recover и goto")
	}
	if r.has("--actor") {
		return errors.New("--actor допустим только в goto")
	}
	if r.has("--comment", "--commit-only") {
		return errors.New("gate arguments допустимы только в режиме gate")
	}
	return nil
}

// validateAttemptAction адресует действия к уже существующей immutable попытке.
// Параметры запуска и родственные команды не могут заменить её ticket, scope и pin.
func (r request) validateAttemptAction() error {
	if !attemptID.MatchString(r.value("--attempt")) {
		return fmt.Errorf("%s требует точный --attempt a_<32hex>", r.mode)
	}
	if r.has("--ticket-json", "--instrumentation-file", "--delivery-target", "--task-comment",
		"--backend-base", "--frontend-base", "--diagnosis-kind", "--diagnosis-signal") {
		const message = "%s использует immutable ticket, scope, diagnosis, sandbox и delivery попытки"
		return fmt.Errorf(message, r.mode)
	}
	switch r.mode {
	case "abandon", "recover", "goto":
		if !r.has("--reason") {
			return fmt.Errorf("%s требует --reason", r.mode)
		}
	default:
		if r.has("--reason") {
			return errors.New("--reason допустим только в abandon, recover и goto")
		}
	}
	if err := r.validateActor(); err != nil {
		return err
	}
	return r.validateDecision()
}

// validateActor оставляет явный источник только для goto.
// Умолчание human не повторяется в поле записи аудита.
func (r request) validateActor() error {
	actor := r.value("--actor")
	switch {
	case actor == "":
		return nil
	case r.mode != "goto":
		return errors.New("--actor допустим только в goto")
	case !nodeID.MatchString(actor):
		return errors.New("--actor: недопустимый идентификатор")
	case actor == "human":
		return errors.New("--actor human является умолчанием и не указывается")
	default:
		return nil
	}
}

// validateDecision проверяет адрес узла и полезную нагрузку решения.
// Stop cleanup доступен только там, где существует нативный контракт Darwin.
func (r request) validateDecision() error {
	node := r.value("--node")
	switch {
	case r.mode == "goto" && !nodeID.MatchString(node):
		return errors.New("goto требует --node с узлом маршрута")
	case r.mode == "recover" && !r.has("--route"):
		return errors.New("recover требует --route для новой попытки")
	case r.mode == "abandon" && r.has("--route"):
		return errors.New("--route не используется в abandon")
	case r.mode == "stop-cleanup" && (runtime.GOOS != "darwin" || r.has("--route")):
		return errors.New("stop-cleanup требует Darwin и exact attempt")
	}
	if r.mode == "gate" {
		if !nodeID.MatchString(node) {
			return errors.New("gate требует --node")
		}
		decision := r.value("--decision")
		if decision != "approved" && decision != "rejected" {
			return errors.New("gate требует --decision approved|rejected")
		}
	} else if r.has("--decision", "--comment", "--commit-only") || (node != "" && r.mode != "goto") {
		return errors.New("gate arguments допустимы только в режиме gate")
	}
	return nil
}

// validateBootstrapAnswer проверяет адрес остановки отдельного визита scout.
// Ответ принимается из физического файла только при точном совпадении формы запроса.
func (r request) validateBootstrapAnswer() error {
	if !taskID.MatchString(r.task) || !attemptID.MatchString(r.value("--attempt")) ||
		r.value("--node") != "scout" || !bootstrapID.MatchString(r.value("--visit")) ||
		!sha256Hex.MatchString(r.value("--stop-hash")) {
		return errors.New("bootstrap-answer требует exact attempt, node scout, visit и stop hash")
	}
	if r.has("--route", "--ticket-json", "--decision", "--comment", "--reason", "--actor", "--format",
		"--commit-only", "--instrumentation-file", "--delivery-target", "--task-comment") {
		return errors.New("bootstrap-answer не принимает параметры запуска или смены маршрута")
	}
	return hooks.CheckFile(r.value("--answer-file"), "answer-file")
}

// validateFindingsExport сохраняет отдельную форму чтения закрытой попытки.
// Флаги запуска и формы решения не принимаются запросом экспорта.
func (r request) validateFindingsExport() error {
	if r.has("--visit", "--stop-hash", "--answer-file") {
		return errors.New("visit, stop-hash и answer-file допустимы только для bootstrap-answer")
	}
	if !taskID.MatchString(r.task) || !attemptID.MatchString(r.value("--attempt")) {
		return errors.New("findings-export требует task и exact --attempt")
	}
	if r.has("--route", "--ticket-json", "--reason", "--actor", "--node", "--decision", "--comment",
		"--commit-only", "--instrumentation-file", "--delivery-target", "--task-comment") {
		return errors.New("findings-export не принимает параметры изменения попытки")
	}
	switch r.value("--format") {
	case "", "json", "markdown":
		return nil
	default:
		return errors.New("findings-export: format должен быть json или markdown")
	}
}
