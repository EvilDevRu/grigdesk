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
	store     state.Store
	identity  state.StageRunnerIdentity
	request   runner.DispatchRequest
	config    string
	speedWire bool
}

type stageSettingsSelection struct {
	Primary       *string `json:"primary"`
	ParametersFor string  `json:"parametersFor"`
	Model         *string `json:"model"`
	Effort        *string `json:"effort"`
	Speed         *string `json:"speed,omitempty"`
}

type stageSettingsPair struct {
	Primary    string `json:"primary"`
	Model      string `json:"model"`
	Effort     string `json:"effort"`
	Speed      string `json:"speed,omitempty"`
	SpeedIssue string `json:"speedIssue,omitempty"`
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
	if r.value("--speed-v1") != "1" {
		result = result.withoutSpeed()
	}
	if err := json.NewEncoder(out).Encode(result); err != nil {
		return 1
	}
	return 0
}

// withoutSpeed сохраняет прежнюю закрытую форму ответа для старого сервера.
// Копия моделей оставляет полный каталог доступным для проверки и записи.
func (view stageSettingsView) withoutSpeed() stageSettingsView {
	view.Selection.Speed = nil
	view.Effective.Speed, view.Effective.SpeedIssue = "", ""
	view.Inherited.Speed, view.Inherited.SpeedIssue = "", ""
	view.Sources.Speed = ""
	if view.Actual != nil {
		actual := *view.Actual
		actual.Speed, actual.SpeedWarning = "", ""
		view.Actual = &actual
	}
	view.Models = append([]runner.StageModel{}, view.Models...)
	for i := range view.Models {
		view.Models[i].SpeedModes = nil
	}
	return view
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
		payload, err = parseStageSettingsApply(raw, service.identity, service.speedWire)
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
		"--speed-v1",
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
		if key == "--speed-v1" && value != "1" {
			return service, "", "", fmt.Errorf("settings_input: неподдерживаемая версия скорости")
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
	filesystem, err := verifyStageSettingsNode(attempt, id)
	if err != nil {
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
		Store: launch.Store, Filesystem: filesystem,
	}
	request.MetadataScope, _ = launch.Store.ReadStageMetadataScope(attempt)
	if request.MetadataScope != nil {
		request.Worktree = request.MetadataScope.Checkout
	}
	if len(request.ProviderChain()) == 0 {
		return service, "", "", fmt.Errorf("provider_conflict: нет профильной цепочки")
	}
	service = stageSettingsCLI{
		store: launch.Store, identity: id, request: request, config: config,
		speedWire: r.value("--speed-v1") == "1",
	}
	return service, provider, payload, nil
}

// verifyStageSettingsNode подтверждает точный runKey и файловую политику.
// Разведке разрешён её закреплённый bootstrap; обычные узлы берутся из route pin.
func verifyStageSettingsNode(attempt state.Attempt, id state.StageRunnerIdentity) (string, error) {
	reader, err := route.NewBundleReader(attempt.RoutesDir, attempt.Profile)
	if err != nil {
		return "", err
	}
	if attempt.RouteHash != "" {
		machine, err := reader.ReadRoute(attempt.RouteID, attempt.RouteHash)
		if err != nil {
			return "", err
		}
		if slices.Contains(machine.AgentStages(id.Node), route.AgentStage{Node: id.Node, Key: id.Stage}) {
			if filesystem, ok := machine.AgentFilesystem(id.Node); ok {
				return filesystem, nil
			}
		}
		if id.Node != "scout" {
			return "", stageSettingsConflict("identity_conflict: этап отсутствует в закреплённом маршруте")
		}
	}
	catalog, err := reader.ReadCatalog(attempt.CatalogHash)
	if err != nil {
		return "", err
	}
	if slices.Contains(catalog.Bootstrap.AgentStages(id.Node), route.AgentStage{Node: id.Node, Key: id.Stage}) {
		if filesystem, ok := catalog.Bootstrap.AgentFilesystem(id.Node); ok {
			return filesystem, nil
		}
	}
	return "", stageSettingsConflict("identity_conflict: этап отсутствует в закреплённом маршруте")
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
	speed := request.InheritedSpeed(provider)
	if !runner.SupportsSpeed(provider, speed) {
		base.SpeedIssue = "invalid_profile"
		speed = ""
	}
	base.Speed = speed
	speedIssue := base.SpeedIssue
	selection := stageSettingsSelection{
		ParametersFor: firstNonempty(saved.Selection.ParametersFor, chain[0]),
		Model:         saved.Selection.Model, Effort: saved.Selection.Effort,
		Speed: saved.Selection.Speed,
	}
	sources := stageSettingsPair{Primary: "profile", Model: "profile", Effort: "profile"}
	if runner.SupportsSpeed(provider, "standard") {
		sources.Speed = "profile"
	}
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
		if selection.Speed != nil {
			speed, sources.Speed, speedIssue = *selection.Speed, "node", ""
		}
	}
	models = append([]runner.StageModel{}, models...)
	fingerprint, _ := json.Marshal([]any{provider, request.Config, models, request.MetadataScope.Fingerprint()})
	hash := sha256.Sum256(fingerprint)
	view := stageSettingsView{
		Schema: 1, Identity: s.identity, Revision: saved.Revision, Selection: selection, Sources: sources,
		Effective: stageSettingsPair{
			Primary: chain[0], Model: model, Effort: effort, Speed: speed, SpeedIssue: speedIssue,
		},
		Chain: chain, Models: models, CatalogRevision: hex.EncodeToString(hash[:]), Receipt: saved.Receipt,
	}
	view.Inherited.stageSettingsPair, view.Inherited.Chain = base, inherited
	return view
}

// save сверяет полный снимок настроек и старую локальную скорость до записи.
// Restart дополнительно закрепляет параметры и происхождение скорости новой эпохи.
func (s stageSettingsCLI) save(
	payload stageSettingsApply, view stageSettingsView,
) (stageSettingsView, error) {
	if payload.CatalogRevision != view.CatalogRevision {
		return stageSettingsView{}, stageSettingsConflict("catalog_stale: каталог моделей или политика изменились")
	}
	selection := payload.Selection
	if !payload.SpeedProvided && selection.ParametersFor == view.Selection.ParametersFor {
		selection.Speed = view.Selection.Speed
	}
	primary := firstNonempty(selection.Primary, view.Inherited.Primary)
	if selection.ParametersFor != primary {
		return stageSettingsView{}, stageSettingsConflict("provider_conflict: parametersFor другого исполнителя")
	}
	model, effort, speed, err := validateStageSettingsPair(selection, view)
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
			Speed: &speed, SpeedFromProfile: selection.Speed == nil,
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
		restart, validatePolicy, s.request.MetadataScope.Fingerprint(),
	)
	if err != nil {
		return stageSettingsView{}, err
	}
	result := s.view(saved, primary, view.Models)
	result.Actual, err = s.store.ReadStageRunnerActual(s.identity)
	return result, err
}

// validateStageSettingsPair подтверждает модель, усилие и явную скорость.
// Профильное ускорение допускается как настройка, подтверждаемая перед запуском.
func validateStageSettingsPair(
	selection state.StageRunnerSelection, view stageSettingsView,
) (model, effort, speed string, err error) {
	model, effort, speed = view.Inherited.Model, view.Inherited.Effort, view.Inherited.Speed
	if selection.Model != nil {
		model = *selection.Model
	}
	if selection.Effort != nil {
		effort = *selection.Effort
	}
	if selection.Speed != nil {
		speed = *selection.Speed
	} else if view.Inherited.SpeedIssue == "invalid_profile" {
		return model, effort, speed, stageSettingsConflict("speed_unavailable: неизвестный режим в профиле")
	}
	checkSpeed := func(modes []string) error {
		if selection.Speed == nil {
			return nil
		}
		if err := runner.ValidateStageSpeed(selection.ParametersFor, speed, modes); err != nil {
			return stageSettingsConflict(err.Error())
		}
		return nil
	}
	if model == "" && selection.Model == nil && selection.Effort == nil {
		return model, effort, speed, checkSpeed(nil)
	}
	for _, item := range view.Models {
		if item.ID == model || slices.Contains(item.Aliases, model) {
			if !slices.Contains(item.Efforts, effort) {
				return model, effort, speed, stageSettingsConflict(
					fmt.Sprintf("effort_unavailable: %q недоступен для %s", effort, model),
				)
			}
			var modes []string
			if item.ID == model {
				modes = item.SpeedModes
			}
			return model, effort, speed, checkSpeed(modes)
		}
	}
	return model, effort, speed, stageSettingsConflict(
		fmt.Sprintf("model_unavailable: модель %q недоступна", model),
	)
}

func stageSettingsConflict(message string) error {
	return fmt.Errorf("%w: %s", state.ErrConflict, message)
}
