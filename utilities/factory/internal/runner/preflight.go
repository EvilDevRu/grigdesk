package runner

import (
	"context"
	"encoding/json"
	"encoding/json/jsontext"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

type StageAdmission struct {
	Key       string
	Selection state.StageRunnerSelection
}

// Preflight снимает один свежий metadata-снимок для нужных цепочек узлов.
// Результат переносится в dispatcher; одной готовой позиции хватает на цепочку.
func Preflight(ctx context.Context, input DispatchRequest, stages []StageAdmission) (map[string]bool, error) {
	ready, incompatible := make(map[string]bool), make(map[string]bool)
	var unavailable []string
	for _, stage := range stages {
		input.Stage, input.Selection = stage.Key, stage.Selection
		chain := input.ProviderChain()
		if len(chain) == 0 {
			return nil, errors.New(preflightFailureMarker(78, nil, nil))
		}
		launchable := false
		for _, id := range chain {
			if !knownProvider(id) {
				return nil, errors.New(preflightFailureMarker(78, nil, nil))
			}
			if _, seen := ready[id]; !seen {
				candidate, err := prepareCandidate(input, id)
				if err == nil {
					err = probeProvider(ctx, candidate)
				}
				ready[id] = err == nil
				var probeError *AdapterError
				incompatible[id] = errors.As(err, &probeError) &&
					probeError.Code == 4 && probeError.Marker == "RUNNER_SUPPLY_INCOMPATIBLE="+id
			}
			launchable = launchable || ready[id]
		}
		if !launchable {
			unavailable = append(unavailable, chain...)
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(unavailable) > 0 {
		return nil, errors.New(preflightFailureMarker(1, unavailable, incompatible))
	}
	return ready, nil
}

// providerHelper ищет фиксированное имя только в физическом runtime движка.
// Комплект использует собранный helper. Checkout содержит исходный вход.
func providerHelper(home, id, source string) string {
	base := filepath.Join(filepath.Dir(home), "server")
	for _, path := range []string{
		filepath.Join(base, "runtime", "helpers", id+".mjs"),
		filepath.Join(base, "scripts", source),
	} {
		real, err := filepath.EvalSymlinks(path)
		if err != nil || real != path || !filepath.IsAbs(path) {
			continue
		}
		info, err := os.Lstat(path)
		if err == nil && info.Mode().IsRegular() {
			return path
		}
	}
	return ""
}

// probeProvider передаёт только metadata argv и безопасное окружение.
// Обычный вывод --version не может установить признак несовместимости GLM.
func probeProvider(ctx context.Context, candidate Candidate) error {
	path := candidate.Binary
	args := []string{"--version"}
	switch candidate.Provider {
	case "glm":
		helper := providerHelper(candidate.Run.FactoryHome, "glm-runtime-info", "glmRuntimeInfo.mts")
		if helper == "" {
			return adapterError(4, "отсутствует metadata helper GLM")
		}
		path, args = candidate.Node, []string{helper, "--probe", "--binary", candidate.Binary}
		if candidate.Run.CacheDirectory != "" {
			args = append(args, "--cache-dir", candidate.Run.CacheDirectory)
		}
	case "qwen":
		path, args = candidate.Node, []string{candidate.Wrapper, "--metadata", "options", "--bin", candidate.Binary}
	}
	path, args = candidate.Run.External.command(path, args)
	env := metadataEnvironment(candidate.Provider, candidate.Run.Environment)
	result := host.RunProcess(ctx, host.Process{Path: path, Args: args,
		Env:     candidate.Run.External.withEnvironment(env),
		Timeout: 8 * time.Second, Limit: 64 * 1024})
	if candidate.Provider == "glm" && result.RC == 1 &&
		!result.OutputOverflow && incompatibleGLM(result.Stderr) {
		return &AdapterError{Code: 4, Marker: "RUNNER_SUPPLY_INCOMPATIBLE=glm"}
	}
	if result.RC != 0 || result.OutputOverflow || strings.TrimSpace(string(result.Stdout)) == "" {
		return adapterError(4, "metadata preflight недоступен")
	}
	return nil
}

func incompatibleGLM(raw []byte) bool {
	var failure struct {
		Code string `json:"code"`
	}
	return jsontext.Value(raw).IsValid() && json.Unmarshal(raw, &failure) == nil &&
		slices.Contains([]string{
			"deepseek_binary_incompatible", "glm_runtime_incompatible", "glm_plugin_missing",
		}, failure.Code)
}

// metadataEnvironment передаёт параметры выбранного CLI. Qwen использует
// объявленные ключи только для metadata API выбранного сервиса.
func metadataEnvironment(provider string, environment []string) []string {
	if provider == "qwen" {
		return providerEnvironment(provider, environment)
	}
	var result []string
	for _, entry := range environment {
		key, _, _ := strings.Cut(entry, "=")
		nativeHome := (provider == "codex" && key == "CODEX_HOME") ||
			(provider == "claude" && key == "CLAUDE_CONFIG_DIR")
		if systemRunnerEnv(key) || nativeHome || slices.Contains([]string{
			"GRIGDESK_HOME", "GRIGDESK_GLM_API_MODE", "GRIGDESK_DEEPSEEK_RUNTIME_MODE",
			"GRIGDESK_QWEN_HOME", "GRIGDESK_QWEN_CONFIG_ROOT", "PYTHONDONTWRITEBYTECODE",
		}, key) {
			result = append(result, entry)
		}
	}
	return result
}
