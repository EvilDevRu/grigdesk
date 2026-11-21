package engine_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScoutPreflightPreservesAttempt(t *testing.T) {
	f := scoutFixture(t, `result=done`)
	f.expectStart(t, true)
	id := f.attempt(t)
	pipeline := filepath.Join(f.store.StateDir, "t"+testTask+".pipeline")
	before, err := os.ReadFile(pipeline)
	if err != nil {
		t.Fatal(err)
	}
	f.installIncompatibleMetadata(t)
	config := filepath.Join(f.profile, "runners.env")
	for _, tc := range []struct{ fallback, marker string }{
		{"", "runner_preflight_incompatible RUNNERS=glm"},
		{"claude", "runner_preflight_unavailable RUNNERS=claude,glm"},
	} {
		f.write(t, config, "RUNNERS_SCHEMA=1\nCONFIG_REVISION=2\nRUNNERS_COVERAGE=required\n"+
			"PROJECT_RUNNER_PRIMARY=glm\nPROJECT_RUNNER_FAILOVER="+tc.fallback+"\n")
		rc, out := f.run(t, "resume", "--attempt", id)
		if rc != 1 || !strings.Contains(out, "[FACTORY_ERROR="+tc.marker+"]") {
			t.Fatalf("preflight rc=%d: %s, требуется %s", rc, out, tc.marker)
		}
		f.expectCount(t, "runner", "")
		f.expectCount(t, "command", "")
		after, err := os.ReadFile(pipeline)
		if err != nil || !bytes.Equal(after, before) {
			t.Fatalf("preflight изменил витрину: %v", err)
		}
	}
}

// installIncompatibleMetadata подменяет только ответ metadata helper на штатный код GLM.
// Любая попытка вызвать wrapper модели падает отдельным tripwire.
func (f *routeFixture) installIncompatibleMetadata(t *testing.T) {
	t.Helper()
	home := filepath.Join(f.dir, "engine")
	scripts := filepath.Join(f.dir, "server", "scripts")
	for _, dir := range []string{home, scripts} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	f.write(t, filepath.Join(scripts, "glmRunner.mts"), "process.exit(97)\n")
	f.write(t, filepath.Join(scripts, "glmRuntimeInfo.mts"), `
console.error(JSON.stringify({ code: 'glm_runtime_incompatible', error: 'Fixture' }));
process.exitCode = 1;
`)
	f.extraEnv = append(f.extraEnv, "FACTORY_HOME="+home, "GRIGDESK_GLM_API_MODE=api",
		"GRIGDESK_DEEPSEEK_BIN="+filepath.Join(f.dir, "codex"),
		"GRIGDESK_CLAUDE_BIN="+filepath.Join(f.dir, "missing-claude"))
}
