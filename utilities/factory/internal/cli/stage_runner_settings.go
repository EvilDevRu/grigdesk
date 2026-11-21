package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"slices"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/route"
	"grigdesk.local/tools/utilities/factory/internal/runner"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

type stageSettingsCLI struct {
	store    state.Store
	identity state.StageRunnerIdentity
	request  runner.DispatchRequest
	config   string
}

type stageSettingsSelection struct {
	Primary       *string `json:"primary"`
	ParametersFor string  `json:"parametersFor"`
	Model         *string `json:"model"`
	Effort        *string `json:"effort"`
}

type stageSettingsPair struct {
	Primary string `json:"primary"`
	Model   string `json:"model"`
	Effort  string `json:"effort"`
}

type stageSettingsView struct {
	Schema          int                       `json:"schema"`
	Identity        state.StageRunnerIdentity `json:"identity"`
	Revision        uint64                    `json:"revision"`
	Selection       stageSettingsSelection    `json:"selection"`
	Sources         stageSettingsPair         `json:"sources"`
	Effective       stageSettingsPair         `json:"effective"`
	Chain           []string                  `json:"chain"`
	Models          []runner.StageModel       `json:"models"`
	CatalogRevision string                    `json:"catalogRevision"`
	Actual          *state.StageRunnerActual  `json:"actual"`
	Receipt         *state.StageRunnerReceipt `json:"receipt"`
	Inherited       struct {
		stageSettingsPair
		Chain []string `json:"chain"`
	} `json:"inherited"`
}

// runTaskRunner обслуживает exact stage-settings для следующего запуска.
// Остальные runner команды по-прежнему требуют своей реализации.
func runTaskRunner(r request, args []string, out, diagnostic io.Writer) int {
	if len(args) < 2 || args[0] != "settings" ||
		!slices.Contains([]string{"show", "options", "apply"}, args[1]) {
		return unavailable(diagnostic)
	}
	result, err := taskRunnerSettings(r, args[1], args[2:])
	if err != nil {
		if errors.Is(err, state.ErrConflict) {
			fmt.Fprintln(diagnostic, err)
			return 75
		}
		if errors.Is(err, runner.ErrStageModelsUnavailable) {
			fmt.Fprintln(diagnostic, err)
			return 69
		}
		return fail(diagnostic, err)
	}
	if err := json.NewEncoder(out).Encode(result); err != nil {
		return 1
	}
	return 0
}

// taskRunnerSettings читает политику по закреплённой попытке и снимает metadata.
// Снимок apply подтверждается до записи, exact replay использует существующий receipt.
func taskRunnerSettings(r request, action string, args []string) (stageSettingsView, error) {
	service, provider, raw, err := stageSettingsContext(r, action, args)
	if err != nil {
		return stageSettingsView{}, err
	}
	saved, err := service.store.ReadStageRunnerSettings(service.identity)
	if err != nil {
		return stageSettingsView{}, err
	}
	var payload stageSettingsApply
	if action == "apply" {
		payload, err = parseStageSettingsApply(raw, service.identity)
		if err != nil {
			return stageSettingsView{}, err
		}
		if replay, err := saved.Replay(payload.Receipt); replay || err != nil {
			return service.view(saved, payload.Selection.ParametersFor, nil), err
		}
		if saved.Revision != payload.ExpectedRevision {
			return stageSettingsView{}, stageSettingsConflict("revision_conflict: настройки уже изменены")
		}
		provider = payload.Selection.ParametersFor
	}
	if provider == "" {
		provider = firstNonempty(saved.Selection.ParametersFor, service.request.ProviderChain()[0])
	}
	models, err := runner.StageModels(context.Background(), service.request, provider)
	if err != nil && action != "show" {
		return stageSettingsView{}, err
	}
	view := service.view(saved, provider, models)
	if action != "apply" {
		view.Actual, err = service.store.ReadStageRunnerActual(service.identity)
		return view, err
	}
	return service.save(payload, view)
}

// stageSettingsContext принимает закрытый набор опций и сверяет профиль и routes root.
// Источник run key для редактора находится в pinned bundle.
func stageSettingsContext(
	r request, action string, args []string,
) (stageSettingsCLI, string, string, error) {
	var service stageSettingsCLI
	keys := []string{
		"--profile", "--attempt", "--node", "--stage", "--routes-dir", "--control-dir", "--state-dir",
	}
	if action == "options" {
		keys = append(keys, "--provider")
	}
	if action == "apply" {
		keys = append(keys, "--payload")
	}
	for len(args) >= 2 {
		key, value := args[0], args[1]
		if !slices.Contains(keys, key) || r.options[key] != nil || value == "" || value[0] == '-' {
			return service, "", "", fmt.Errorf("settings_input: неверная или повторная опция %s", key)
		}
		r.options[key] = []string{value}
		args = args[2:]
	}
	provider, payload := r.value("--provider"), r.value("--payload")
	if len(args) != 0 || (action == "options" && !runnerID.MatchString(provider)) ||
		(action == "apply" && payload == "") {
		return service, "", "", fmt.Errorf("settings_input: неполные аргументы %s", action)
	}
	r.mode = action
	launch := makeLaunchRequest(r, io.Discard)
	id := state.StageRunnerIdentity{Task: r.task, Profile: launch.Profile, Attempt: launch.Attempt,
		Node: r.value("--node"), Stage: r.value("--stage")}
	attempt, err := launch.Store.ReadAttempt(id.Task, id.Attempt)
	if err != nil {
		return service, "", "", err
	}
	if attempt.Profile != id.Profile || attempt.RoutesDir != launch.RoutesDir || attempt.Terminal != "" {
		return service, "", "", stageSettingsConflict("identity_conflict: другой профиль, попытка или routes-dir")
	}
	if err := verifyStageSettingsNode(attempt, id); err != nil {
		return service, "", "", err
	}
	_, _, config := hooks.ProfileFiles(id.Profile)
	settings, err := hooks.RunnerConfig(config)
	if err != nil {
		return service, "", "", err
	}
	executable, err := os.Executable()
	if err != nil {
		return service, "", "", err
	}
	request := runner.DispatchRequest{
		Stage: id.Stage, Primary: attempt.RunnerPrimaryOverride, Config: settings,
		FactoryHome: runner.FactoryHome(launch.Environment, executable), Environment: launch.Environment,
	}
	if len(request.ProviderChain()) == 0 {
		return service, "", "", fmt.Errorf("provider_conflict: нет профильной цепочки")
	}
	service = stageSettingsCLI{store: launch.Store, identity: id, request: request, config: config}
	return service, provider, payload, nil
}

func verifyStageSettingsNode(attempt state.Attempt, id state.StageRunnerIdentity) error {
	reader, err := route.NewBundleReader(attempt.RoutesDir, attempt.Profile)
	if err != nil {
		return err
	}
	if attempt.RouteHash != "" {
		machine, err := reader.ReadRoute(attempt.RouteID, attempt.RouteHash)
		if err != nil {
			return err
		}
		if slices.Contains(machine.AgentStages(id.Node), route.AgentStage{Node: id.Node, Key: id.Stage}) {
			return nil
		}
		if id.Node != "scout" {
			return stageSettingsConflict("identity_conflict: этап отсутствует в закреплённом маршруте")
		}
	}
	catalog, err := reader.ReadCatalog(attempt.CatalogHash)
	if err != nil {
		return err
	}
	if slices.Contains(catalog.Bootstrap.AgentStages(id.Node), route.AgentStage{Node: id.Node, Key: id.Stage}) {
		return nil
	}
	return stageSettingsConflict("identity_conflict: этап отсутствует в закреплённом маршруте")
}

// view собирает прежнюю wire-схему, используемую сервером и редактором.
// Наследование вычисляется для запрошенного провайдера, отдельным полем от выбора узла.
func (s stageSettingsCLI) view(
	saved state.StageRunnerSettings, provider string, models []runner.StageModel,
) stageSettingsView {
	inherited := s.request.ProviderChain()
	request := s.request
	request.Selection = saved.Selection
	chain := request.ProviderChain()
	model, effort := request.InheritedParameters(provider)
	base := stageSettingsPair{Primary: inherited[0], Model: model, Effort: effort}
	selection := stageSettingsSelection{
		ParametersFor: firstNonempty(saved.Selection.ParametersFor, chain[0]),
		Model:         saved.Selection.Model, Effort: saved.Selection.Effort,
	}
	sources := stageSettingsPair{Primary: "profile", Model: "profile", Effort: "profile"}
	if request.Primary != "" {
		sources.Primary = "attempt"
	}
	if saved.Selection.Primary != "" {
		selection.Primary = &saved.Selection.Primary
		sources.Primary = "node"
	}
	if selection.ParametersFor == provider {
		if selection.Model != nil {
			model, sources.Model = *selection.Model, "node"
		}
		if selection.Effort != nil {
			effort, sources.Effort = *selection.Effort, "node"
		}
	}
	models = append([]runner.StageModel{}, models...)
	fingerprint, _ := json.Marshal([]any{provider, request.Config, models})
	hash := sha256.Sum256(fingerprint)
	view := stageSettingsView{
		Schema: 1, Identity: s.identity, Revision: saved.Revision, Selection: selection, Sources: sources,
		Effective: stageSettingsPair{Primary: chain[0], Model: model, Effort: effort},
		Chain:     chain, Models: models, CatalogRevision: hex.EncodeToString(hash[:]), Receipt: saved.Receipt,
	}
	view.Inherited.stageSettingsPair, view.Inherited.Chain = base, inherited
	return view
}

func (s stageSettingsCLI) save(
	payload stageSettingsApply, view stageSettingsView,
) (stageSettingsView, error) {
	if payload.CatalogRevision != view.CatalogRevision {
		return stageSettingsView{}, stageSettingsConflict("catalog_stale: каталог моделей или политика изменились")
	}
	selection := payload.Selection
	primary := firstNonempty(selection.Primary, view.Inherited.Primary)
	if selection.ParametersFor != primary {
		return stageSettingsView{}, stageSettingsConflict("provider_conflict: parametersFor другого исполнителя")
	}
	model, effort, err := validateStageSettingsPair(selection, view)
	if err != nil {
		return stageSettingsView{}, err
	}
	if selection.Primary != "" && primary == view.Chain[0] {
		selection.Failover = view.Chain[1:]
	}
	var restart *state.StageRunnerRestart
	if payload.Restart {
		fallback := selection.Failover
		if selection.Primary == "" {
			fallback = view.Inherited.Chain[1:]
		}
		restart = &state.StageRunnerRestart{
			Source: *payload.ExpectedRun, RequestID: payload.Receipt.RequestID,
			Primary: primary, Model: model, Effort: effort, Failover: fallback,
		}
	}
	validatePolicy := func() error {
		current, err := hooks.RunnerConfig(s.config)
		if err != nil {
			return err
		}
		if !maps.Equal(current, s.request.Config) {
			return stageSettingsConflict("catalog_stale: политика модели изменилась во время проверки")
		}
		return nil
	}
	saved, err := s.store.SaveStageRunnerSettings(
		s.identity, payload.ExpectedRevision, payload.ExpectedRun, selection, payload.Receipt,
		restart, validatePolicy,
	)
	if err != nil {
		return stageSettingsView{}, err
	}
	result := s.view(saved, primary, view.Models)
	result.Actual, err = s.store.ReadStageRunnerActual(s.identity)
	return result, err
}

// validateStageSettingsPair подтверждает пару выбором ровно одной модели из каталога.
// Возвращённые значения можно зафиксировать для замены живого запуска.
func validateStageSettingsPair(
	selection state.StageRunnerSelection, view stageSettingsView,
) (model, effort string, err error) {
	model, effort = view.Inherited.Model, view.Inherited.Effort
	if selection.Model != nil {
		model = *selection.Model
	}
	if selection.Effort != nil {
		effort = *selection.Effort
	}
	if model == "" && selection.Model == nil && selection.Effort == nil {
		return model, effort, nil
	}
	for _, item := range view.Models {
		if item.ID == model || slices.Contains(item.Aliases, model) {
			if !slices.Contains(item.Efforts, effort) {
				return model, effort, stageSettingsConflict(
					fmt.Sprintf("effort_unavailable: %q недоступен для %s", effort, model),
				)
			}
			return model, effort, nil
		}
	}
	return model, effort, stageSettingsConflict(fmt.Sprintf("model_unavailable: модель %q недоступна", model))
}

func stageSettingsConflict(message string) error {
	return fmt.Errorf("%w: %s", state.ErrConflict, message)
}
