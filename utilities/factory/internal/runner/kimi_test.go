package runner

import (
	"os"
	"path/filepath"
	"testing"
)

func TestKimiAdapter(t *testing.T) {
	run := adapterFixture(t)
	home := filepath.Join(run.Worktree, "kimi-home")
	if err := os.MkdirAll(filepath.Join(home, "credentials"), 0700); err != nil {
		t.Fatal(err)
	}
	config := []byte("[model]\nname = \"fixture\"\n[thinking]\neffort = \"low\"\n")
	if err := os.WriteFile(filepath.Join(home, "config.toml"), config, 0600); err != nil {
		t.Fatal(err)
	}
	envLog := filepath.Join(run.Worktree, "kimi.env")
	body := "printf '%s\\n' \"$KIMI_CODE_HOME\" >" + shellQuote(envLog) + "\n" + submitFixtureResult
	binary := fakeRunnerCLI(t, run.Worktree, "kimi", body)
	_, err := runKimiAdapter(run, binary, home, "invalid", "промпт")
	if err == nil || err.Code != 4 {
		t.Errorf("невалидный effort: %v", err)
	}
	outcome, err := runKimiAdapter(run, binary, home, "high", "промпт")
	if err != nil || outcome.Terminal.Result != "done" {
		t.Fatalf("Kimi не принял результат: %+v %v", outcome, err)
	}
	checkFixtureFile(t, filepath.Join(run.Worktree, "kimi.calls"), "-p\nпромпт\n")
	runHome := filepath.Join(run.Dir, "kimi-home")
	checkFixtureFile(t, envLog, runHome)
	checkFixtureFile(t, filepath.Join(runHome, "config.toml"), "[thinking]\neffort = \"high\"")
	link, targetErr := os.Readlink(filepath.Join(runHome, "credentials"))
	if targetErr != nil || link != filepath.Join(home, "credentials") {
		t.Fatalf("credentials link=%s: %v", link, targetErr)
	}
}
