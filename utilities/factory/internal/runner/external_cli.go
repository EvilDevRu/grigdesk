package runner

import (
	"encoding/json"
	"encoding/json/jsontext"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

type externalCLI struct {
	Bin, Identity, ProviderID, ResourceKey, LeaseDirectory string
	LeaseCommand                                           []string
	Env                                                    map[string]string
}

var externalDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var externalEnvName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// readExternalCLI принимает только частный descriptor хоста и закрепляет одну
// физическую копию. Без записи своего провайдера работает локальный выбор CLI.
func readExternalCLI(file, provider string) (*externalCLI, error) {
	if file == "" || !slices.Contains([]string{"claude", "codex", "kimi", "qwen"}, provider) {
		return nil, nil
	}
	physical, err := filepath.EvalSymlinks(file)
	if err != nil || !filepath.IsAbs(file) || physical != file {
		return nil, fmt.Errorf("descriptor внешнего CLI должен быть физическим файлом")
	}
	f, err := host.OpenPath(file, os.O_RDONLY, 0, host.Nonblocking)
	if err != nil {
		return nil, fmt.Errorf("не удалось открыть descriptor внешнего CLI")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || !host.RealFileOwner(f, info) ||
		!host.SingleLink(f, info) || !host.PrivateMode(f, info, 0600) {
		return nil, fmt.Errorf("нужен частный descriptor внешнего CLI")
	}
	const limit = 1024 * 1024
	raw, err := io.ReadAll(io.LimitReader(f, limit+1))
	var document struct {
		SchemaVersion int
		Providers     map[string]*externalCLI
	}
	if err != nil || len(raw) > limit || !jsontext.Value(raw).IsValid() ||
		json.Unmarshal(raw, &document) != nil || document.SchemaVersion != 1 {
		return nil, fmt.Errorf("неверный descriptor внешнего CLI")
	}
	entry := document.Providers[provider]
	if entry != nil && !entry.valid(provider) {
		return nil, fmt.Errorf("неверная identity выбранного CLI %s", provider)
	}
	return entry, nil
}

func (entry *externalCLI) valid(provider string) bool {
	return entry.ProviderID == provider && externalDigest.MatchString(entry.Identity) &&
		externalDigest.MatchString(entry.ResourceKey) && filepath.IsAbs(entry.LeaseDirectory) &&
		filepath.Clean(entry.LeaseDirectory) == entry.LeaseDirectory &&
		filepath.IsAbs(entry.Bin) && len(entry.LeaseCommand) > 0 && filepath.IsAbs(entry.LeaseCommand[0])
}

// withEnvironment добавляет переданную хостом среду выбранной копии и профиля.
// Capability и loader controls выдаёт только доверенный Go-хост.
func (entry *externalCLI) withEnvironment(env []string) []string {
	if entry == nil {
		return env
	}
	result := slices.Clone(env)
	for name, value := range entry.Env {
		if externalEnvName.MatchString(name) && !strings.ContainsRune(value, 0) &&
			!strings.HasPrefix(name, "FACTORY_") && !strings.HasPrefix(name, "LD_") &&
			!strings.HasPrefix(name, "DYLD_") && !slices.Contains(
			[]string{"BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "HOME", "SHELL"}, name) {
			result = append(result, name+"="+value)
		}
	}
	return result
}

// command помещает lease перед точным CLI и сохраняет argv без shell-оценки.
// Qwen использует тот же lease API через Node wrapper своего адаптера.
func (entry *externalCLI) command(path string, args []string) (string, []string) {
	if entry == nil || path != entry.Bin {
		return path, args
	}
	prefix := append(slices.Clone(entry.LeaseCommand[1:]),
		"--identity", entry.Identity, "--lease-dir", entry.LeaseDirectory,
		"--provider", entry.ProviderID, "--resource", entry.ResourceKey, "--", path)
	return entry.LeaseCommand[0], append(prefix, args...)
}

// SaveStageMetadataScope закрепляет те же копии CLI, которые выбрал бы запуск.
// Недоступный провайдер исключается, а его причина передаётся безопасным кодом.
func SaveStageMetadataScope(
	attempt state.Attempt, store state.Store, checkout string, environment []string,
) (problems []string, err error) {
	scope := state.StageMetadataScope{
		Checkout: checkout, Providers: make(map[string]state.StageMetadataCLI),
		MetadataEnvironment: make(map[string]string),
	}
	for key, value := range environmentMap(environment) {
		if systemRunnerEnv(key) || key == "GRIGDESK_HOME" {
			scope.MetadataEnvironment[key] = value
		}
	}
	request := DispatchRequest{
		FactoryHome: environmentMap(environment)["FACTORY_HOME"], Environment: environment,
	}
	for _, provider := range []string{"codex", "claude"} {
		candidate, err := prepareCandidate(request, provider)
		if err != nil {
			problems = append(problems, "entry_unavailable:"+provider)
			continue
		}
		digest, err := state.StageMetadataExecutableDigest(candidate.Binary)
		if err != nil {
			problems = append(problems, "entry_unavailable:"+provider)
			continue
		}
		entry := state.StageMetadataCLI{Executable: candidate.Binary, Digest: digest}
		if external := candidate.Run.External; external != nil {
			entry.Identity, entry.ResourceKey = external.Identity, external.ResourceKey
			entry.LeaseDirectory, entry.LeaseCommand = external.LeaseDirectory, external.LeaseCommand
		}
		nativeHome := "CODEX_HOME"
		if provider == "claude" {
			nativeHome = "CLAUDE_CONFIG_DIR"
		}
		entry.MetadataEnvironment = make(map[string]string)
		for key, value := range environmentMap(candidate.Run.Environment) {
			if !systemRunnerEnv(key) && key != "GRIGDESK_HOME" && key != nativeHome {
				continue
			}
			if inherited, present := scope.MetadataEnvironment[key]; !present || value != inherited {
				entry.MetadataEnvironment[key] = value
			}
		}
		scope.Providers[provider] = entry
	}
	return problems, store.WriteStageMetadataScope(attempt, scope)
}

// scopeMetadataEnvironment добавляет разрешённое окружение конкретной копии CLI.
// Отдельные PATH внешних исполнителей не подменяют друг друга.
func scopeMetadataEnvironment(scope *state.StageMetadataScope, provider string) []string {
	overrides := scope.Providers[provider].MetadataEnvironment
	environment := make(map[string]string, len(scope.MetadataEnvironment)+len(overrides))
	maps.Copy(environment, scope.MetadataEnvironment)
	maps.Copy(environment, overrides)
	result := make([]string, 0, len(environment))
	for _, key := range slices.Sorted(maps.Keys(environment)) {
		result = append(result, key+"="+environment[key])
	}
	return metadataEnvironment(provider, result)
}
