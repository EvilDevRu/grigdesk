package runner

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeepSeekGlmLaunch(t *testing.T) {
	for _, provider := range []string{"deepseek", "glm"} {
		t.Run(provider, func(t *testing.T) {
			run := adapterFixture(t)
			run.Model = `["deepseek-official","deepseek-v4-flash"]`
			run.Binary = fakeRunnerCLI(t, run.Worktree, "pinned-elf", "")
			run.Environment = append(run.Environment, "ZAI_API_KEY=fixture",
				"ZAI_CODING_API_KEY=fixture", "GRIGDESK_GLM_ROUTE_KEY=must-not-inherit")
			check := `[[ -z ${ZAI_API_KEY:-} && -z ${ZAI_CODING_API_KEY:-} ]] || exit 93`
			if provider == "glm" {
				check = `[[ -n ${ZAI_API_KEY:-} && -n ${ZAI_CODING_API_KEY:-} ]] || exit 94`
			}
			check += "\n" + `[[ -z ${GRIGDESK_GLM_ROUTE_KEY:-} ]] || exit 95`
			wrapper := fakeRunnerCLI(t, run.Worktree, "node", check+"\n"+submitFixtureResult)
			var outcome Outcome
			var err *AdapterError
			mode := "read-only"
			policy := routePolicy{filesystem: "state-only"}
			if provider == "deepseek" {
				outcome, err = runDeepSeekAdapter(run, wrapper, policy, "канарейка промпта")
			} else {
				run.Model = `["zai","glm-5"]`
				mode = "state-only"
				outcome, err = runGlmAdapter(run, wrapper, "", "api", policy, "канарейка промпта")
			}
			if err != nil || outcome.Classification != "ok" || outcome.Terminal.Result != "done" {
				t.Fatalf("исход: %+v %v", outcome, err)
			}
			calls := filepath.Join(run.Worktree, "node.calls")
			raw := checkFixtureFile(t, calls, "--mode\n"+mode+"\n", "--cwd\n"+run.Store.StateDir+"\n")
			prompt := fixtureOption(t, raw, "--prompt-file")
			info, statErr := os.Stat(prompt)
			if statErr != nil || info.Mode().Perm() != 0600 || strings.Contains(raw, "канарейка промпта") {
				t.Fatalf("prompt transport: %v", statErr)
			}
			checkFixtureFile(t, prompt, "канарейка промпта")
		})
	}
	t.Run("fail-closed", func(t *testing.T) {
		run := adapterFixture(t)
		binary := fakeRunnerCLI(t, run.Worktree, "blocked-node", "")
		policy := routePolicy{filesystem: "state-only"}
		_, err := runDeepSeekAdapter(run, binary, routePolicy{filesystem: "danger-full-access"}, "prompt")
		if err == nil || err.Code != 4 {
			t.Fatalf("filesystem gate: %v", err)
		}
		run.ExpectedVersion, run.Version = "pinned", "changed"
		_, err = runDeepSeekAdapter(run, binary, policy, "prompt")
		if err == nil || !strings.Contains(err.Marker, "FACTORY_ERROR=runtime_changed RUNNERS=deepseek") {
			t.Fatalf("runtime gate: %v", err)
		}
		_, err = runGlmAdapter(run, binary, "glm_runtime_incompatible", "api", policy, "prompt")
		if err == nil || !strings.Contains(err.Marker, "RUNNER_SUPPLY_INCOMPATIBLE=glm") {
			t.Fatalf("supply gate: %v", err)
		}
		_, err = runGlmAdapter(run, binary, "", "web", policy, "prompt")
		if err == nil || err.Code != 4 {
			t.Fatalf("mode gate: %v", err)
		}
		if _, err := os.Stat(filepath.Join(run.Worktree, "blocked-node.calls")); !os.IsNotExist(err) {
			t.Fatalf("wrapper исполнился до допуска: %v", err)
		}
	})
}

func fixtureOption(t *testing.T, text, flag string) string {
	t.Helper()
	_, tail, present := strings.Cut(text, flag+"\n")
	if !present {
		t.Fatalf("отсутствует argv %s", flag)
	}
	value, _, _ := strings.Cut(tail, "\n")
	return value
}

// TestDeepSeekNativeStatus проверяет настоящий runtime и принятый результат
// через loopback из тестовой папки. Обычный offline набор не требует пакет DSH.
func TestDeepSeekNativeStatus(t *testing.T) {
	dsh := os.Getenv("FACTORY_TEST_DEEPSEEK_BIN")
	if dsh == "" {
		t.Skip("нужен явно выделенный тестовый DeepSeek ELF")
	}
	run := adapterFixture(t)
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	node, err = filepath.EvalSymlinks(node)
	if err != nil {
		t.Fatal(err)
	}
	run.Binary = dsh
	run.FactoryHome = filepath.Join(root, "engine")
	run.Wrapper = filepath.Join(root, "tests/fixtures/serverBinary/factoryGoDeepSeek.mts")
	run.Model = `["deepseek-official","deepseek-v4-flash"]`
	run.Effort = "off"
	run.CacheDirectory = filepath.Join(run.Worktree, "dsh-cache")
	run.Timeout = 60 * time.Second
	run.Environment = append(run.Environment,
		"FACTORY_HOME="+run.FactoryHome,
		"GRIGDESK_DEEPSEEK_RUNTIME_MODE=binary",
		"DEEPSEEK_API_KEY=synthetic-loopback-only",
	)
	result, fault := runDeepSeekAdapter(
		run, node, routePolicy{filesystem: "workspace-write"}, "Передай статус один раз.",
	)
	if fault != nil || result.Terminal.Result != "done" {
		log, _ := os.ReadFile(filepath.Join(run.Dir, "stderr.log"))
		t.Fatalf("передача статуса не подтверждена: %+v %v\n%s", result, fault, log)
	}
	if result.Terminal.Comment != "Ответ loopback принят фабрикой" {
		t.Fatalf("терминальный комментарий изменился: %q", result.Terminal.Comment)
	}
	checkFixtureFile(t, filepath.Join(run.Dir, "loopback.count"), "3\n")
	checkFixtureFile(t, filepath.Join(run.Dir, "meta.env"), "SOURCE=runtime", "RUNNER=deepseek")
	checkFixtureFile(t, filepath.Join(run.Store.StateDir, "t8101.pipeline"), "SIZE=M", "BUILD=done")
}
