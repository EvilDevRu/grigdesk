package runner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

func TestExternalCLIPin(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex")
	lease := filepath.Join(dir, "lease")
	marker := filepath.Join(dir, "probe")
	descriptor := filepath.Join(dir, "external.json")
	write := func(name, content string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(name, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
	write(binary, "#!/bin/sh\n[ \"$1\" = --version ] || exit 4\nprintf 'codex %s\\n' 1.0.0\n", 0700)
	write(lease, `#!/bin/sh
while [ "$1" != -- ]; do
  shift
done
shift
printf '%s\n' "$1" >"$MARKER"
exec "$@"
`, 0700)
	entry := externalCLI{Bin: binary, ProviderID: "codex", LeaseCommand: []string{lease},
		Identity: strings.Repeat("a", 64), ResourceKey: strings.Repeat("b", 64), LeaseDirectory: dir,
		Env: map[string]string{"MARKER": marker, "FACTORY_RUN_ID": "foreign"}}
	raw, err := json.Marshal(map[string]any{"schemaVersion": 1, "providers": map[string]externalCLI{"codex": entry}})
	if err != nil {
		t.Fatal(err)
	}
	write(descriptor, string(raw), 0600)
	candidate, err := prepareCandidate(DispatchRequest{
		Environment: []string{"FACTORY_EXTERNAL_CLI_DESCRIPTOR=" + descriptor, "GRIGDESK_CODEX_BIN=/absent"},
	}, "codex")
	if err != nil || candidate.Binary != binary {
		t.Fatalf("точная копия из descriptor: %s, %v", candidate.Binary, err)
	}
	if err := probeProvider(t.Context(), candidate); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(marker)
	if err != nil || string(got) != binary+"\n" {
		t.Fatalf("probe прошёл мимо lease: %q, %v", got, err)
	}
	if slices.Contains(candidate.Run.Environment, "FACTORY_RUN_ID=foreign") {
		t.Fatal("descriptor подменил host scope")
	}
	if err := os.Chmod(descriptor, 0664); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareCandidate(DispatchRequest{
		Environment: []string{"FACTORY_EXTERNAL_CLI_DESCRIPTOR=" + descriptor, "GRIGDESK_CODEX_BIN=" + binary},
	}, "codex"); err == nil {
		t.Fatal("group-writable descriptor выбрал CLI")
	}
}

// TestStageMetadataUsesExternalProviderEnvironment проверяет точное окружение обеих проб.
// PATH выбранной копии отличается от PATH фабрики, а произвольный ключ не попадает в metadata.
func TestStageMetadataUsesExternalProviderEnvironment(t *testing.T) {
	run := adapterFixture(t)
	attempt, err := run.Store.ReadAttempt(run.Identity.Task, run.Identity.Attempt)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	write := func(name, body string, mode os.FileMode) string {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
		return path
	}
	lease := write("lease", `#!/bin/sh
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
`, 0700)
	codex := write("codex", `#!/bin/sh
[ "$PATH" = "$HOME/codex-path" ] && [ "$CODEX_HOME" = "$HOME/codex-home" ] || exit 4
[ -z "$CODEX_FIXTURE_SECRET" ] || exit 5
printf 'fast_mode stable true\n'
`, 0700)
	claude := write("claude", "#!/bin/sh\nexit 0\n", 0700)
	providers := map[string]externalCLI{
		"codex": {
			Bin:        codex,
			ProviderID: "codex",
			Env: map[string]string{
				"PATH":                 root + "/codex-path",
				"CODEX_HOME":           root + "/codex-home",
				"CODEX_FIXTURE_SECRET": "hidden",
			},
		},
		"claude": {
			Bin:        claude,
			ProviderID: "claude",
			Env: map[string]string{
				"PATH":                  root + "/claude-path",
				"CLAUDE_CONFIG_DIR":     root + "/claude-home",
				"CLAUDE_FIXTURE_SECRET": "hidden",
			},
		},
	}
	for provider, entry := range providers {
		entry.Identity, entry.ResourceKey = strings.Repeat("a", 64), strings.Repeat("b", 64)
		entry.LeaseDirectory, entry.LeaseCommand = root, []string{lease}
		providers[provider] = entry
	}
	raw, err := json.Marshal(map[string]any{"schemaVersion": 1, "providers": providers})
	if err != nil {
		t.Fatal(err)
	}
	descriptor := write("external.json", string(raw), 0600)
	problems, err := SaveStageMetadataScope(attempt, run.Store, root, []string{
		"PATH=/factory-path", "HOME=" + root, "FACTORY_EXTERNAL_CLI_DESCRIPTOR=" + descriptor,
	})
	if err != nil || len(problems) > 0 {
		t.Fatalf("снимок выбранных копий: %v, %v", problems, err)
	}
	scope, problem := run.Store.ReadStageMetadataScope(attempt)
	if scope == nil || problem != "" {
		t.Fatalf("подтверждённый снимок не прочитан: %s", problem)
	}
	if err := os.MkdirAll(filepath.Join(root, "server", "scripts"), 0700); err != nil {
		t.Fatal(err)
	}
	write("server/scripts/factoryRunnerModels.mts", "", 0600)
	node := write("node", `#!/bin/sh
case "$2" in
  codex) [ "$PATH" = "$HOME/codex-path" ] && [ "$CODEX_HOME" = "$HOME/codex-home" ] || exit 4 ;;
  claude) [ "$PATH" = "$HOME/claude-path" ] && [ "$CLAUDE_CONFIG_DIR" = "$HOME/claude-home" ] || exit 4 ;;
  *) exit 5 ;;
esac
[ -z "$CODEX_FIXTURE_SECRET$CLAUDE_FIXTURE_SECRET" ] || exit 6
printf '%s\n' '{"schema":1,"models":[{"id":"fixture","efforts":["high"],"speedModes":["fast"]}]}'
`, 0700)
	request := DispatchRequest{
		FactoryHome: filepath.Join(root, "engine"), Environment: []string{"NODE_BIN=" + node},
		Filesystem: "workspace-write", Worktree: root, MetadataScope: scope,
	}
	for _, provider := range []string{"codex", "claude"} {
		models, err := StageModels(t.Context(), request, provider)
		if err != nil || len(models) != 1 || !slices.Equal(models[0].SpeedModes, []string{"standard", "fast"}) {
			t.Errorf("%s: каталог должен подтвердить fast в окружении выбранного CLI: %v, %v", provider, models, err)
		}
	}
}

// TestStageMetadataCLIValidMatchesExternalCLI сравнивает независимо проверяемые поля.
// Детерминированные примеры охраняют совпадение проверок доверенной записи и descriptor.
func TestStageMetadataCLIValidMatchesExternalCLI(t *testing.T) {
	base := externalCLI{
		Bin: filepath.Join(t.TempDir(), "codex"), ProviderID: "codex",
		Identity: strings.Repeat("a", 64), ResourceKey: strings.Repeat("b", 64),
		LeaseDirectory: t.TempDir(), LeaseCommand: []string{os.Args[0]},
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	base.LeaseCommand = []string{executable, "fixture"}
	for label, modify := range map[string]func(*externalCLI){
		"valid":      func(*externalCLI) {},
		"identity":   func(entry *externalCLI) { entry.Identity = "wrong" },
		"resource":   func(entry *externalCLI) { entry.ResourceKey = "" },
		"directory":  func(entry *externalCLI) { entry.LeaseDirectory = "." },
		"unclean":    func(entry *externalCLI) { entry.LeaseDirectory += string(os.PathSeparator) },
		"command":    func(entry *externalCLI) { entry.LeaseCommand = nil },
		"relative":   func(entry *externalCLI) { entry.LeaseCommand = []string{"lease"} },
		"executable": func(entry *externalCLI) { entry.Bin = "codex" },
	} {
		t.Run(label, func(t *testing.T) {
			external := base
			modify(&external)
			entry := state.StageMetadataCLI{
				Executable: external.Bin, Identity: external.Identity, ResourceKey: external.ResourceKey,
				LeaseDirectory: external.LeaseDirectory, LeaseCommand: external.LeaseCommand,
			}
			if entry.ValidExternal() != external.valid("codex") {
				t.Fatalf("разошлись правила внешнего CLI: %s", label)
			}
		})
	}
}
