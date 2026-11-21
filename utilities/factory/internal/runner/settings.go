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
	ID      string   `json:"id"`
	Label   string   `json:"label,omitempty"`
	Efforts []string `json:"efforts"`
	Aliases []string `json:"aliases,omitempty"`
}

var ErrStageModelsUnavailable = errors.New("metadata_unavailable")

// StageModels использует metadata helper из того же runtime, что и адаптер.
// Каталог не получает prompt, capability FD или секреты запуска узла.
func StageModels(ctx context.Context, req DispatchRequest, provider string) ([]StageModel, error) {
	candidate, err := prepareCandidate(req, provider)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrStageModelsUnavailable, err)
	}
	node := candidate.Node
	if node == "" {
		configured := environmentMap(req.Environment)["NODE_BIN"]
		if configured == "" {
			configured, _ = exec.LookPath("node")
		}
		node, err = existingExecutable(configured)
		if err != nil {
			return nil, fmt.Errorf("%w: Node не найден", ErrStageModelsUnavailable)
		}
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
	if provider == "deepseek" || provider == "glm" {
		env = append(env, "GRIGDESK_DEEPSEEK_BIN="+candidate.Binary, "GRIGDESK_DEEPSEEK_RUNTIME_MODE=binary")
	}
	result := host.RunProcess(ctx, host.Process{Path: node,
		Args: []string{helper, provider, catalog, candidate.Binary},
		Dir:  filepath.Dir(req.FactoryHome), Env: env, Timeout: 15 * time.Second, Limit: 2 * 1024 * 1024})
	var metadata struct {
		Schema int          `json:"schema"`
		Models []StageModel `json:"models"`
	}
	if result.RC != 0 || result.OutputOverflow || !jsontext.Value(result.Stdout).IsValid() ||
		json.Unmarshal(result.Stdout, &metadata) != nil || metadata.Schema != 1 || len(metadata.Models) == 0 {
		return nil, fmt.Errorf("%w: каталог %s недоступен", ErrStageModelsUnavailable, provider)
	}
	for index := range metadata.Models {
		item := &metadata.Models[index]
		if item.ID == "" || len(item.Efforts) == 0 {
			return nil, fmt.Errorf("%w: неверная модель в каталоге %s", ErrStageModelsUnavailable, provider)
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
	return metadata.Models, nil
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
