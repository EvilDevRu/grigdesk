package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeAdapter(t *testing.T) {
	t.Run("host-settings", func(t *testing.T) {
		run := adapterFixture(t)
		run.Worktree = filepath.Join(run.Worktree, "checkout")
		if err := os.Mkdir(run.Worktree, 0700); err != nil {
			t.Fatal(err)
		}
		run.ReadAgentRules = func(context.Context) ([]string, []string, error) {
			return []string{"Bash(make test:*)"}, []string{"Bash(git push:*)"}, nil
		}
		body := `
[[ "$FACTORY_STATUS_MODE" == request && -z "${FACTORY_CONTROL_ROOT:-}" ]] || exit 89
while [[ $# -gt 0 && $1 != --settings ]]; do shift; done
[[ "$(stat -c %a -- "$2")" == 400 ]] || exit 90
cat -- "$2" >"$FACTORY_STATE/claude-settings-proof.json"
` + submitFixtureResult
		binary := fakeRunnerCLI(t, run.Worktree, "claude", body)
		out, err := runClaudeAdapter(run, binary, "", "промпт", routePolicy{filesystem: "workspace-write"})
		if err != nil || out.Terminal.Result != "done" {
			t.Fatalf("штатные настройки Claude: %+v %v", out, err)
		}
		proof := filepath.Join(run.Store.StateDir, "claude-settings-proof.json")
		checkFixtureFile(t, proof, `"failIfUnavailable":true`, filepath.Base(run.Factory)+" stage-result",
			"Bash(make test:*)", "Bash(git push:*)")
	})
	for _, kind := range []string{"trusted-settings", "outside", "missing-deny", "excluded", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			run := adapterFixture(t)
			binary := fakeRunnerCLI(t, run.Worktree, "claude", submitFixtureResult)
			path := claudeFixtureSettings(t, run, kind)
			out, err := runClaudeAdapter(run, binary, path, "промпт", routePolicy{})
			calls := filepath.Join(run.Worktree, "claude.calls")
			if kind != "trusted-settings" {
				if err == nil || err.Code != 78 {
					t.Fatalf("недоверенные настройки: %+v %v", out, err)
				}
				if _, err := os.Stat(calls); !os.IsNotExist(err) {
					t.Fatalf("CLAUDE запущен до проверки settings: %v", err)
				}
				return
			}
			if err != nil || out.Terminal.Result != "done" {
				stderr, _ := os.ReadFile(filepath.Join(run.Dir, "stderr.log"))
				t.Fatalf("доверенные настройки: %+v %v\n%s", out, err, stderr)
			}
			argv := checkFixtureFile(t, calls, "-p\nпромпт\n", "--setting-sources\n\n",
				"--strict-mcp-config\n", "--disable-slash-commands\n")
			for _, flag := range []string{"--dangerously-skip-permissions", "--safe-mode", "--mcp-config\n"} {
				if strings.Contains(argv, flag) {
					t.Fatalf("лишний argv %q", flag)
				}
			}
		})
	}
}

func claudeFixtureSettings(t *testing.T, run Run, kind string) string {
	t.Helper()
	root := run.Store.ControlDir
	file := filepath.Join(root, "claude.json")
	var deny []string
	for _, tool := range []string{"Read", "Edit", "Write", "NotebookEdit"} {
		prefix := tool + "(//" + strings.TrimPrefix(root, "/")
		deny = append(deny, prefix+")", prefix+"/**)")
	}
	if kind == "missing-deny" {
		deny = deny[:len(deny)-1]
	}
	doc := map[string]any{"permissions": map[string]any{"deny": deny}}
	if kind == "outside" {
		file = filepath.Join(run.Worktree, "outside.json")
	}
	if kind == "excluded" {
		doc["sandbox"] = map[string]any{"excludedCommands": []string{"git"}}
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, raw, 0400); err != nil {
		t.Fatal(err)
	}
	if kind == "symlink" {
		link := filepath.Join(root, "link.json")
		if err := os.Symlink(file, link); err != nil {
			t.Fatal(err)
		}
		return link
	}
	return file
}

// TestClaudeFactorySpeedSettings проверяет явный булев fastMode.
// Наследование оставляет исходную форму settings.
func TestClaudeFactorySpeedSettings(t *testing.T) {
	dir := t.TempDir()
	for speed, want := range map[string]any{"": nil, "standard": false, "fast": true} {
		run := Run{Speed: speed, Worktree: filepath.Join(dir, "work"), Factory: filepath.Join(dir, "factory")}
		run.Store.ControlDir = filepath.Join(dir, "control")
		run.Store.StateDir = filepath.Join(dir, "state")
		doc, err := run.claudeSettingsDocument(routePolicy{filesystem: "workspace-write"})
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err := json.Unmarshal(data, &value); err != nil {
			t.Fatal(err)
		}
		if got, present := value["fastMode"]; got != want || present != (speed != "") {
			t.Fatalf("%q: fastMode=%v, присутствует=%t", speed, got, present)
		}
	}
}
