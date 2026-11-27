package runner

import (
	"context"
	"encoding/json"
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

type StageModel struct {
	ID         string   `json:"id"`
	Label      string   `json:"label,omitempty"`
	Efforts    []string `json:"efforts"`
	Aliases    []string `json:"aliases,omitempty"`
	SpeedModes []string `json:"speedModes,omitempty"`
}

// ValidateStageSpeed отличает выключение ускорения от подтверждённого режима модели.
// Метаданные каталога нужны только для Fast и Ultrafast.
func ValidateStageSpeed(provider, speed string, modes []string) error {
	if !SupportsSpeed(provider, speed) ||
		(speed != "" && speed != "standard" && !slices.Contains(modes, speed)) {
		return fmt.Errorf("%w: %q недоступна для %s", ErrStageSpeedUnavailable, speed, provider)
	}
	return nil
}

// checkCandidateSpeed подтверждает ускорение точного model ID до публикации эпохи.
// Нативный каталог получает метаданные без prompt и права на запись результата.
func checkCandidateSpeed(ctx context.Context, req DispatchRequest, candidate Candidate) error {
	speed := candidate.Run.Speed
	if speed == "" || speed == "standard" || !SupportsSpeed(candidate.Provider, speed) || candidate.Model == "" {
		return ValidateStageSpeed(candidate.Provider, speed, nil)
	}
	models, err := stageModels(ctx, req, candidate)
	if err != nil {
		return fmt.Errorf("%w: %s: %v", ErrStageSpeedUnavailable, candidate.Provider, err)
	}
	for _, model := range models {
		if model.ID == candidate.Model {
			return ValidateStageSpeed(candidate.Provider, speed, model.SpeedModes)
		}
	}
	return ValidateStageSpeed(candidate.Provider, speed, nil)
}

var ErrStageModelsUnavailable = errors.New("metadata_unavailable")
var ErrStageSpeedUnavailable = errors.New("speed_unavailable")

// StageModels использует metadata helper из того же runtime, что и адаптер.
// Каталог не получает prompt, capability FD или секреты запуска узла.
func StageModels(ctx context.Context, req DispatchRequest, provider string) ([]StageModel, error) {
	candidate, err := prepareCandidate(req, provider)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrStageModelsUnavailable, err)
	}
	return stageModels(ctx, req, candidate)
}

// stageModels снимает каталог конкретного кандидата в его runtime.
// Метаданные редактора и admission используют одну проверку режима и привязки.
func stageModels(ctx context.Context, req DispatchRequest, candidate Candidate) ([]StageModel, error) {
	provider := candidate.Provider
	node := candidate.Node
	if node == "" {
		configured := environmentMap(req.Environment)["NODE_BIN"]
		if configured == "" {
			configured, _ = exec.LookPath("node")
		}
		resolved, err := existingExecutable(configured)
		if err != nil {
			return nil, fmt.Errorf("%w: Node не найден", ErrStageModelsUnavailable)
		}
		node = resolved
	}
	helper := providerHelper(req.FactoryHome, "factory-runner-models", "factoryRunnerModels.mts")
	if helper == "" {
		return nil, fmt.Errorf("%w: отсутствует factory-runner-models", ErrStageModelsUnavailable)
	}
	catalog := "--native"
	switch provider {
	case "deepseek":
		catalog = strings.Join(deepSeekModels, "\n")
	case "kimi":
		catalog = "kimi-code/k3\nkimi-code/k3-256k\nkimi-code/kimi-for-coding\nkimi-code/kimi-for-coding-highspeed"
	}
	env := metadataEnvironment(provider, candidate.Run.Environment)
	cwd := filepath.Dir(req.FactoryHome)
	scoped := false
	var features codexFeatures
	if candidate.matchesMetadataScope(req) {
		env = scopeMetadataEnvironment(req.MetadataScope, provider)
		probeCwd := stageMetadataWorkingDir(req)
		scoped = probeCwd != ""
		if scoped && provider == "codex" {
			cwd = probeCwd
			features, _ = probeCodexFeatures(ctx, req, candidate)
		}
	}
	if provider == "deepseek" || provider == "glm" {
		env = append(env, "GRIGDESK_DEEPSEEK_BIN="+candidate.Binary, "GRIGDESK_DEEPSEEK_RUNTIME_MODE=binary")
	}
	args := []string{helper, provider, catalog, candidate.Binary}
	if external := candidate.Run.External; external != nil && (provider == "codex" || provider == "claude") {
		wire, _ := json.Marshal(map[string]string{
			"executable": candidate.Binary, "executableIdentity": external.Identity,
			"resourceKey": external.ResourceKey, "providerId": provider, "leaseDirectory": external.LeaseDirectory,
		})
		args = append(args, string(wire))
	}
	result := host.RunProcess(ctx, host.Process{Path: node,
		Args: args, Dir: cwd, Env: env, Timeout: 15 * time.Second, Limit: 2 * 1024 * 1024, Owned: true})
	var metadata struct {
		Schema int          `json:"schema"`
		Models []StageModel `json:"models"`
	}
	if result.Err != nil || result.RC != 0 || result.OutputOverflow || !result.OwnedTreeClosed ||
		!jsontext.Value(result.Stdout).IsValid() ||
		json.Unmarshal(result.Stdout, &metadata) != nil || metadata.Schema != 1 || len(metadata.Models) == 0 {
		return nil, fmt.Errorf("%w: каталог %s недоступен", ErrStageModelsUnavailable, provider)
	}
	for index := range metadata.Models {
		item := &metadata.Models[index]
		if item.ID == "" || len(item.Efforts) == 0 {
			return nil, fmt.Errorf("%w: неверная модель в каталоге %s", ErrStageModelsUnavailable, provider)
		}
		seen := make(map[string]bool)
		for _, mode := range item.SpeedModes {
			if mode == "" || seen[mode] || !SupportsSpeed(provider, mode) {
				return nil, fmt.Errorf("%w: неверная скорость в каталоге %s", ErrStageModelsUnavailable, provider)
			}
			seen[mode] = true
		}
		if provider == "deepseek" {
			if !slices.Contains(deepSeekModels, item.ID) {
				return nil, fmt.Errorf("%w: неверная модель в каталоге %s", ErrStageModelsUnavailable, provider)
			}
			if !slices.Contains(item.Efforts, "") {
				item.Efforts = append([]string{""}, item.Efforts...)
			}
		}
	}
	return applyStageSpeedModes(provider, metadata.Models, scoped, features), nil
}

// matchesMetadataScope связывает кандидата с точной копией из записи попытки.
// Даже без cwd для ускорения каталог модели читает закреплённое окружение.
func (candidate Candidate) matchesMetadataScope(req DispatchRequest) bool {
	scope, provider := req.MetadataScope, candidate.Provider
	if scope == nil {
		return false
	}
	entry, ok := scope.Providers[provider]
	if !ok || candidate.Binary != entry.Executable {
		return false
	}
	external := candidate.Run.External
	if external == nil && entry.Identity != "" || external != nil &&
		(external.Identity != entry.Identity || external.ResourceKey != entry.ResourceKey ||
			external.LeaseDirectory != entry.LeaseDirectory ||
			!slices.Equal(external.LeaseCommand, entry.LeaseCommand)) {
		return false
	}
	return true
}

// stageMetadataWorkingDir подтверждает cwd для metadata, влияющей на скорость.
// При недоступной политике остаётся прежний каталог модели и усилия.
func stageMetadataWorkingDir(req DispatchRequest) string {
	cwd := codexWorkingDir(Run{Worktree: req.Worktree, Store: req.Store}, req.Filesystem)
	switch req.Filesystem {
	case "state-only":
	case "workspace-write", "transactional-write":
		if cwd != req.MetadataScope.Checkout {
			return ""
		}
	default:
		return ""
	}
	if physicalRunnerDirectory(cwd) {
		return cwd
	}
	return ""
}

// codexFeatures содержит подтверждённые самим CLI флаги ускорения.
// Выключенный флаг срезает режим независимо от ответа model/list.
type codexFeatures struct {
	FastMode, UltrafastMode bool
}

// probeCodexFeatures спрашивает точную копию CLI о флагах ускорения.
// При дедлайне или отмене host подтверждает закрытие всей сессии вместе с lease.
func probeCodexFeatures(
	ctx context.Context, req DispatchRequest, candidate Candidate,
) (codexFeatures, error) {
	if req.MetadataScope == nil {
		return codexFeatures{}, fmt.Errorf("speed_unavailable: scope absent")
	}
	cwd := codexWorkingDir(Run{Worktree: req.Worktree, Store: req.Store}, req.Filesystem)
	executable, args := candidate.Run.External.command(candidate.Binary, []string{"features", "list"})
	result := host.RunProcess(ctx, host.Process{
		Path: executable, Args: args, Dir: cwd,
		Env:     scopeMetadataEnvironment(req.MetadataScope, "codex"),
		Timeout: 5 * time.Second, Limit: 64 * 1024, Owned: true,
	})
	if result.Err != nil || result.RC != 0 || result.OutputOverflow || !result.OwnedTreeClosed {
		return codexFeatures{}, fmt.Errorf("speed_unavailable: features list: код %d", result.RC)
	}
	var flags codexFeatures
	for line := range strings.SplitSeq(string(result.Stdout), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || fields[2] != "true" {
			continue
		}
		switch fields[0] {
		case "fast_mode":
			flags.FastMode = true
		case "ultrafast_mode":
			flags.UltrafastMode = true
		}
	}
	return flags, nil
}

// applyStageSpeedModes оставляет ускорения, подтверждённые каталогом и снимком CLI.
// Standard остаётся доступным при деградации поддерживаемого адаптера.
func applyStageSpeedModes(
	provider string, models []StageModel, scoped bool, flags codexFeatures,
) []StageModel {
	for i := range models {
		if !SupportsSpeed(provider, "standard") {
			models[i].SpeedModes = nil
			continue
		}
		modes := slices.DeleteFunc(models[i].SpeedModes, func(mode string) bool {
			return mode != "standard" && (!scoped ||
				provider == "codex" && (mode == "fast" && !flags.FastMode ||
					mode == "ultrafast" && !flags.UltrafastMode))
		})
		if !slices.Contains(modes, "standard") {
			modes = append([]string{"standard"}, modes...)
		}
		models[i].SpeedModes = modes
	}
	return models
}

// FactoryHome определяет корень привязанных helpers по окружению выбранного runtime.
// Исходная раскладка bin соседствует с engine, переносимая хранит бинарник в самом engine.
func FactoryHome(environment []string, executable string) string {
	home := environmentMap(environment)["FACTORY_HOME"]
	if home != "" {
		return home
	}
	home = filepath.Dir(filepath.Dir(executable))
	source := filepath.Join(home, "engine")
	abi := filepath.Join(source, "lib", "delivery_contract.py")
	if info, err := os.Lstat(abi); err == nil && info.Mode().IsRegular() {
		return source
	}
	return home
}
