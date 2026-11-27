package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

type DispatchRequest struct {
	Store                        state.Store
	Task, Attempt, Stage, Role   string
	Profile                      string
	Node                         string
	Prompt, Filesystem, Worktree string
	Factory, FactoryHome         string
	Primary                      string
	Selection                    state.StageRunnerSelection
	SpeedFromProfile             bool
	Config                       map[string]string
	Environment                  []string
	MetadataScope                *state.StageMetadataScope
	Timeout                      time.Duration
	NoResultRetries              int
	Shared                       bool
	CodexShared                  *CodexSharedAccess
	AgentControlDir              string
	ReadAgentRules               func(context.Context) ([]string, []string, error)
	Ready                        map[string]bool
	ReadSelection                func() (state.StageRunnerSelection, error)
	RecordRestart                func(state.RunIdentity, state.StageRunnerRestart, bool) error
	BeforeInvoke                 func(string) (string, error)
	AfterInvoke                  func(DispatchResult) error
}

type Candidate struct {
	Provider, Binary, Node, Wrapper string
	Model, Effort, Access           string
	Run                             Run
}

type DispatchResult struct {
	Outcome
	Run      state.RunIdentity
	Provider string
}

func Providers() []string {
	return slices.Clone(providerIDs)
}

// Dispatch выбирает цепочку по профилю и проводит каждый запуск через новую epoch.
// Только разрешённые классы отказа допускают следующего исполнителя.
func Dispatch(ctx context.Context, input DispatchRequest) (DispatchResult, error) {
	policy := routePolicy{filesystem: input.Filesystem, shared: input.Shared}
	var last DispatchResult
	var unavailable []string
	if _, err := input.refreshSelection(ctx); err != nil {
		return last, err
	}
	chain := input.ProviderChain()
	noResults := make(map[string]int)
	var replacement *state.StageRunnerRestart
	var source state.RunIdentity
	var speedErr error
	defer func() {
		if replacement != nil {
			reason := "Новый запуск не допущен."
			if speedErr != nil {
				reason = speedErr.Error()
			}
			_ = input.Store.AdvanceStageRunnerRestart(source, *replacement, "failed", reason)
		}
	}()
	position, conflicts := 0, 0
	prompt, prepared := input.Prompt, false
	// Перечитывание после CAS не выпускает эпоху и сохраняет результат BeforeInvoke.
	// Замороженный restart не может подменить потерянное намерение новым выбором.
	retryAdmission := func(conflict error) error {
		conflicts++
		if conflicts >= 3 || replacement != nil {
			return conflict
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := input.refreshSelection(ctx); err != nil {
			return err
		}
		chain, position = input.ProviderChain(), 0
		unavailable, speedErr = nil, nil
		return nil
	}
	for position < len(chain) {
		provider := chain[position]
		if input.Ready != nil && !input.Ready[provider] {
			unavailable = append(unavailable, provider)
			position++
			continue
		}
		candidate, err := prepareCandidate(input, provider)
		if err != nil {
			unavailable = append(unavailable, provider)
			if policyAllowsSwitch("preflight", "unavailable_preflight", false) {
				position++
				continue
			}
			return last, err
		}
		if err := ctx.Err(); err != nil {
			return last, err
		}
		var admission []state.StageSelectionAdmission
		if input.ReadSelection != nil || replacement != nil {
			admission = []state.StageSelectionAdmission{{Selection: input.Selection, Restart: replacement}}
		}
		if refusal := checkCandidateSpeed(ctx, input, candidate); refusal != nil {
			if err := ctx.Err(); err != nil {
				return last, err
			}
			local := input.Selection.ParametersFor == provider &&
				input.Selection.Speed != nil && !input.SpeedFromProfile
			if local {
				if len(admission) != 0 {
					id := state.StageRunnerIdentity{Task: input.Task, Profile: input.Profile,
						Attempt: input.Attempt, Node: input.Node, Stage: input.Stage}
					err := input.Store.CheckStageAdmissionSelection(id, admission[0])
					if errors.Is(err, state.ErrConflict) {
						if err := retryAdmission(err); err != nil {
							return last, err
						}
						continue
					}
					if err != nil {
						return last, err
					}
				}
				speedErr = refusal
				unavailable = append(unavailable, provider)
				position++
				continue
			}
			candidate.Run.Speed, candidate.Run.SpeedWarning = "standard", "profile_speed_unavailable"
		}
		if err := ctx.Err(); err != nil {
			return last, err
		}
		if !prepared && input.BeforeInvoke != nil {
			prompt, err = input.BeforeInvoke(prompt)
			if err != nil {
				return last, err
			}
			prepared = true
		}
		candidate.Run.context, candidate.Run.RecordRestart = ctx, input.RecordRestart
		started := false
		if replacement != nil {
			candidate.Run.ConfirmRestart = func(id state.RunIdentity) error {
				err := input.Store.AdvanceStageRunnerRestart(id, *replacement, "started", "")
				started = err == nil
				return err
			}
		}
		run, refusal := beginEpoch(candidate.Run, input.Task, input.Attempt, input.Stage, input.Role, admission...)
		if refusal != nil {
			if errors.Is(refusal, state.ErrConflict) {
				if err := retryAdmission(refusal); err != nil {
					return last, err
				}
				continue
			}
			return last, refusal
		}
		candidate.Run = run
		outcome, failure := candidate.invoke(prompt, policy)
		last = DispatchResult{Outcome: outcome, Run: run.Identity, Provider: provider}
		if failure != nil && failure.Restart != nil {
			last.RC = 130
			// invoke отдаёт намерение только после подтверждённого закрытия дерева.
			last.OwnedTreeClosed = true
			replacement, source = failure.Restart, run.Identity
		}
		if err := ctx.Err(); err != nil {
			// Хост возвращает 130 только после подтверждённого завершения дерева.
			if last.RC == 130 || failure == nil {
				return last, err
			}
			return last, failure
		}
		if input.AfterInvoke != nil {
			if err := input.AfterInvoke(last); err != nil {
				return last, err
			}
		}
		prompt, prepared, conflicts = input.Prompt, false, 0
		if failure != nil && failure.Restart != nil {
			if err := input.Store.AdvanceStageRunnerRestart(source, *replacement, "consumed", ""); err != nil {
				return last, err
			}
			if input.RecordRestart != nil {
				if err := input.RecordRestart(source, *replacement, true); err != nil {
					return last, err
				}
			}
			input.Selection = replacement.Selection()
			input.SpeedFromProfile = replacement.SpeedFromProfile
			ready, err := Preflight(ctx, input, []StageAdmission{{Key: input.Stage, Selection: input.Selection}})
			if err != nil {
				return last, fmt.Errorf("перезапуск этапа %s: выбранный исполнитель недоступен", input.Stage)
			}
			input.Ready = ready
			chain, position = input.ProviderChain(), 0
			unavailable, speedErr = nil, nil
			clear(noResults)
			continue
		}
		if started {
			replacement = nil
		}
		if failure == nil {
			return last, nil
		}
		switch {
		case outcome.Classification == "no_result":
			if noResults[provider] >= input.NoResultRetries {
				last.Classification = "exhausted"
				return last, nil
			}
			noResults[provider]++
		case policyAllowsSwitch("started", outcome.Classification, true):
			position++
		default:
			return last, failure
		}
		if position < len(chain) && replacement == nil {
			changed, err := input.refreshSelection(ctx)
			if err != nil {
				return last, err
			}
			if changed {
				chain, position = input.ProviderChain(), 0
			}
		}
	}
	if speedErr != nil {
		return last, fmt.Errorf("%s: %w", preflightFailureMarker(1, unavailable, nil), speedErr)
	}
	if last.Provider != "" {
		last.Classification = "exhausted"
		return last, nil
	}
	return last, fmt.Errorf("%s", preflightFailureMarker(1, unavailable, nil))
}

// refreshSelection перечитывает выбор между epoch, когда следующий запуск уже разрешён.
// Новая цепочка получает собственную metadata-проверку. Бюджет no-result остаётся прежним.
func (input *DispatchRequest) refreshSelection(ctx context.Context) (bool, error) {
	if input.ReadSelection == nil {
		return false, nil
	}
	selected, err := input.ReadSelection()
	if err != nil || reflect.DeepEqual(selected, input.Selection) {
		return false, err
	}
	input.Selection = selected
	input.SpeedFromProfile = selected.Speed == nil
	ready, err := Preflight(ctx, *input, []StageAdmission{{Key: input.Stage, Selection: selected}})
	if err != nil {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		return false, fmt.Errorf("новый выбор исполнителя этапа %s недоступен", input.Stage)
	}
	input.Ready = ready
	return true, nil
}

// ProviderChain использует закреплённый выбор попытки и сохраняет порядок failover.
// Этой же цепочкой редактор объясняет наследование будущего запуска.
func (input DispatchRequest) ProviderChain() []string {
	if input.Selection.Primary != "" {
		return append([]string{input.Selection.Primary}, input.Selection.Failover...)
	}
	if input.Primary != "" {
		return []string{input.Primary}
	}
	prefix := "STAGE_" + input.Stage
	primary, failover := input.Config[prefix+"_PRIMARY"], input.Config[prefix+"_FAILOVER"]
	if primary == "" {
		primary, failover = input.Config["PROJECT_RUNNER_PRIMARY"], input.Config["PROJECT_RUNNER_FAILOVER"]
	}
	seen := make(map[string]bool)
	var chain []string
	for _, item := range append([]string{primary}, strings.Split(failover, ",")...) {
		if item != "" && !seen[item] {
			seen[item] = true
			chain = append(chain, item)
		}
	}
	return chain
}

func prepareCandidate(req DispatchRequest, id string) (Candidate, error) {
	if !knownProvider(id) {
		return Candidate{}, fmt.Errorf("неизвестный провайдер")
	}
	values := environmentMap(req.Environment)
	external, err := readExternalCLI(values["FACTORY_EXTERNAL_CLI_DESCRIPTOR"], id)
	if err != nil {
		return Candidate{}, err
	}
	upper := strings.ToUpper(id)
	path := values["GRIGDESK_"+upper+"_BIN"]
	if id == "glm" {
		path = values["GRIGDESK_DEEPSEEK_BIN"]
	}
	if external != nil {
		path = external.Bin
	} else if req.MetadataScope != nil && values["FACTORY_EXTERNAL_CLI_DESCRIPTOR"] == "" {
		if entry, ok := req.MetadataScope.Providers[id]; ok {
			path = entry.Executable
			if entry.Identity != "" {
				external = &externalCLI{
					Bin: path, Identity: entry.Identity, ProviderID: id, ResourceKey: entry.ResourceKey,
					LeaseDirectory: entry.LeaseDirectory, LeaseCommand: entry.LeaseCommand,
				}
			}
		}
	}
	if id == "qwen" && path == "qwen" {
		path, _ = exec.LookPath(path)
	}
	if path == "" {
		switch id {
		case "deepseek", "glm":
			path = filepath.Join(filepath.Dir(req.FactoryHome), "bin", "deepseek")
		default:
			path, _ = exec.LookPath(id)
		}
	}
	path, err = existingExecutable(path)
	if err != nil {
		return Candidate{}, err
	}
	if external != nil && path != external.Bin {
		return Candidate{}, fmt.Errorf("выбранный внешний CLI изменил физический путь")
	}
	model, effort := req.InheritedParameters(id)
	speed := req.InheritedSpeed(id)
	if req.Selection.ParametersFor == id {
		if req.Selection.Model != nil {
			model = *req.Selection.Model
		}
		if req.Selection.Effort != nil {
			effort = *req.Selection.Effort
		}
		if req.Selection.Speed != nil {
			speed = *req.Selection.Speed
		}
	}
	c := Candidate{Provider: id, Binary: path, Model: model, Effort: effort}
	c.Run = Run{
		Store: req.Store, Worktree: req.Worktree, Factory: req.Factory, FactoryHome: req.FactoryHome,
		Model: model, Effort: effort, Speed: speed, Node: req.Node,
		Binary: path, Environment: external.withEnvironment(req.Environment), External: external,
		Timeout: req.Timeout, CodexShared: req.CodexShared,
		AgentControlDir: req.AgentControlDir, ReadAgentRules: req.ReadAgentRules,
	}
	if id == "deepseek" || id == "glm" || id == "qwen" {
		c, err = wrapperCandidate(req, c, values)
	}
	return c, err
}

// InheritedParameters разрешает профильную пару одинаково для редактора и запуска.
// Более точный ключ этапа имеет приоритет над общим MODEL_DEFAULT провайдера.
func (req DispatchRequest) InheritedParameters(id string) (model, effort string) {
	key := ProviderKey(id)
	setting := []string{"MODEL_" + req.Stage + "_" + key + "_", "MODEL_DEFAULT_" + key + "_"}
	model = firstSetting(req.Config, setting, "EXACT")
	if model == "" {
		model = firstSetting(req.Config, setting, "FAMILY")
	}
	effort = firstSetting(req.Config, setting, "EFFORT")
	model = selectDefaultModel(id, model)
	if id == "kimi" && effort == "" {
		effort = "high"
	}
	return model, effort
}

// InheritedSpeed применяет ролевой ключ перед default для выбранного исполнителя.
// Ошибочное значение поддерживаемого адаптера сохраняется для диагностики.
func (req DispatchRequest) InheritedSpeed(id string) string {
	if !SupportsSpeed(id, "standard") {
		return ""
	}
	key := ProviderKey(id)
	prefixes := []string{"MODEL_" + req.Stage + "_" + key + "_", "MODEL_DEFAULT_" + key + "_"}
	return firstSetting(req.Config, prefixes, "SPEED")
}

func wrapperCandidate(req DispatchRequest, c Candidate, env map[string]string) (Candidate, error) {
	upper := strings.ToUpper(c.Provider)
	executable := env["GRIGDESK_"+upper+"_NODE_BIN"]
	if c.Provider == "glm" {
		executable = env["GRIGDESK_DEEPSEEK_NODE_BIN"]
	}
	if executable == "" {
		executable = env["NODE_BIN"]
	}
	if executable == "" {
		executable, _ = exec.LookPath("node")
	}
	node, err := existingExecutable(executable)
	if err != nil {
		return c, err
	}
	wrapper := providerHelper(req.FactoryHome, c.Provider+"-runner", c.Provider+"Runner.mts")
	if wrapper == "" {
		return c, fmt.Errorf("отсутствует %s wrapper", c.Provider)
	}
	c.Node, c.Wrapper, c.Run.Wrapper = node, wrapper, wrapper
	c.Access = env["GRIGDESK_GLM_API_MODE"]
	c.Run.ExpectedVersion = env["FACTORY_RUNNER_VERSION"]
	c.Run.Version = env["GRIGDESK_"+upper+"_RUNTIME_VERSION"]
	c.Run.RuntimeIdentity = env["GRIGDESK_"+upper+"_RUNTIME_IDENTITY"]
	c.Run.CacheDirectory = env["GRIGDESK_"+upper+"_CACHE_DIR"]
	if c.Provider == "glm" {
		c.Run.CacheDirectory = env["GRIGDESK_DEEPSEEK_CACHE_DIR"]
	}
	return c, nil
}

func (candidate Candidate) invoke(prompt string, policy routePolicy) (Outcome, *AdapterError) {
	run := candidate.Run
	env := environmentMap(run.Environment)
	switch candidate.Provider {
	case "codex":
		return runCodexAdapter(run, candidate.Binary, prompt, policy)
	case "deepseek":
		return runDeepSeekAdapter(run, candidate.Node, policy, prompt)
	case "glm":
		return runGlmAdapter(run, candidate.Node, "", candidate.Access, policy, prompt)
	case "claude":
		return runClaudeAdapter(run, candidate.Binary, env["RUNNER_CLAUDE_SETTINGS"], prompt, policy)
	case "kimi":
		home := env["KIMI_CODE_HOME"]
		if home == "" {
			home = filepath.Join(env["HOME"], ".kimi-code")
		}
		return runKimiAdapter(run, candidate.Binary, home, candidate.Effort, prompt)
	case "qwen":
		return runQwenAdapter(run, candidate.Node, policy, candidate.Model, prompt)
	default:
		return Outcome{RC: 78}, adapterError(78, "провайдера нет в реестре")
	}
}

func existingExecutable(path string) (string, error) {
	if path == "" || !filepath.IsAbs(path) {
		return "", fmt.Errorf("нет абсолютного CLI descriptor")
	}
	physical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	file, err := os.Stat(physical)
	if err != nil || !host.Executable(physical, file) {
		return "", fmt.Errorf("CLI descriptor не исполняется")
	}
	return physical, nil
}

func environmentMap(entries []string) map[string]string {
	values := make(map[string]string)
	for _, entry := range entries {
		key, value, found := strings.Cut(entry, "=")
		if found {
			values[key] = value
		}
	}
	return values
}

func firstSetting(config map[string]string, prefixes []string, field string) string {
	for _, prefix := range prefixes {
		if value := config[prefix+field]; value != "" {
			return value
		}
	}
	return ""
}

func selectDefaultModel(provider, model string) string {
	switch provider {
	case "deepseek":
		if model == "" || model == "default" {
			model = "deepseek-v4-flash"
		}
		return fmt.Sprintf(`["deepseek-official",%q]`, model)
	case "glm":
		if model == "" || model == "default" {
			model = "glm-5"
		}
		return fmt.Sprintf(`["zai",%q]`, model)
	default:
		if model == "default" {
			return ""
		}
		return model
	}
}
