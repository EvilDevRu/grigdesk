package runner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestQwenAdapterArgs(t *testing.T) {
	run := adapterFixture(t)
	run.Binary = fakeRunnerCLI(t, run.Worktree, "pinned-qwen", "")
	run.Environment = append(run.Environment, "GRIGDESK_QWEN_BIN=/fabricated/path", "QWEN_API_KEY=fixture")
	body := `[ "$QWEN_API_KEY" = fixture ] || exit 71` + "\n" + submitFixtureResult
	wrapper := fakeRunnerCLI(t, run.Worktree, "node", body)
	policy := routePolicy{filesystem: "state-only"}
	out, err := runQwenAdapter(run, wrapper, policy, "qwen3-coder", "канарейка промпта")
	if err != nil || out.Terminal.Result != "done" {
		t.Fatalf("исход: %+v %v", out, err)
	}
	log := filepath.Join(run.Worktree, "node.calls")
	argv := checkFixtureFile(t, log, "--bin\n"+run.Binary+"\n", "--mode\nstate-only\n",
		"--cwd\n"+run.Store.StateDir+"\n")
	prompt := fixtureOption(t, argv, "--prompt-file")
	info, statErr := os.Stat(prompt)
	if statErr != nil || info.Mode().Perm() != 0600 || strings.Contains(argv, "канарейка промпта") ||
		strings.Contains(argv, "QWEN_API_KEY") || strings.Contains(argv, "/fabricated/path") {
		t.Fatalf("fingerprint транспорта: %v", statErr)
	}
	checkFixtureFile(t, prompt, "канарейка промпта")
}
