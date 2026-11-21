package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProfileCheckQuick(t *testing.T) {
	physical, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	profiles, state := filepath.Join(physical, "fixture profiles"), filepath.Join(physical, "caller state")
	profile := filepath.Join(profiles, "demo-profile")
	for _, dir := range []string{profile, state} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	canary := filepath.Join(state, "canary")
	for file, content := range map[string]string{
		canary:                               "исходное состояние",
		filepath.Join(profile, "graph.json"): `{"capabilities":[],"launchable":false}`,
		filepath.Join(profile, "profile.sh"): "touch \"$STATE_DIR/неожиданный-хук\"\n",
	} {
		if err := os.WriteFile(file, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", physical)
	t.Setenv("STATE_DIR", state)
	t.Setenv("FACTORY_STATE", state)
	t.Setenv("FACTORY_PROFILES_DIR", profiles)

	for _, args := range [][]string{
		{"profile-check", "demo-profile", "--quick"},
		{"profile-check", "--quick", "demo-profile"},
		{"profile-check", "--quick"},
		{"profile-check", "demo-profile", "--host-preflight", "--quick"},
	} {
		var out, diag bytes.Buffer
		rc := Run(args, &out, &diag)
		if rc != 0 || !strings.Contains(out.String(), "задач не ведёт") {
			t.Errorf("argv=%q rc=%d stdout=%q stderr=%q", args, rc, out.String(), diag.String())
		}
	}
	entries, err := os.ReadDir(state)
	if err != nil || len(entries) != 1 || entries[0].Name() != "canary" {
		t.Fatalf("проверка изменила состояние: %v, %v", entries, err)
	}
	contents, err := os.ReadFile(canary)
	if err != nil || string(contents) != "исходное состояние" {
		t.Fatalf("canary=%q, ошибка=%v", contents, err)
	}
}

func TestProfileCheckHostMetadata(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(root, "profiles", "fixture")
	bin := filepath.Join(root, "bin")
	for _, dir := range []string{profile, bin} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(profile, "graph.json"): `{"capabilities":["route-v2"]}`,
		filepath.Join(profile, "runners.env"): "RUNNERS_SCHEMA=1\nCONFIG_REVISION=1\n" +
			"RUNNERS_COVERAGE=required\nPROJECT_RUNNER_PRIMARY=codex\n",
		filepath.Join(profile, "profile.sh"): `
profile_workspace_mode() { printf 'isolated\n'; }
profile_repositories() { printf 'app\t/source\t/worktree\n'; }
profile_project_context() { printf '{"stack":["fixture"],"guardrails":[]}\n'; }
profile_source_branch() { printf 'task-71\n'; }
profile_container() { printf 'fixture\n'; }
profile_stand_alive() { return 0; }
`,
		filepath.Join(bin, "codex"): `#!/bin/bash
if [[ $# -ne 1 || "$1" != --version ]]; then exit 97; fi
printf '%s\n' "$1" >> "$PROBE_LOG"
printf 'codex-cli 0.42.0\n'
`,
	}
	for path, content := range files {
		if err := os.WriteFile(path, []byte(content), 0700); err != nil {
			t.Fatal(err)
		}
	}
	log := filepath.Join(root, "probe.log")
	t.Setenv("HOME", root)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+"/usr/bin:/bin")
	t.Setenv("FACTORY_PROFILES_DIR", filepath.Dir(profile))
	t.Setenv("FACTORY_FORBID_LIVE", "1")
	t.Setenv("PROBE_LOG", log)
	args := []string{"profile-check", "fixture", "--host-preflight", "--quick"}

	t.Setenv("RUN_HOST_PREFLIGHT", "0")
	var out, diagnostic bytes.Buffer
	if rc := Run(args, &out, &diagnostic); rc != 1 ||
		!strings.Contains(out.String(), "RUN_HOST_PREFLIGHT=1") {
		t.Fatalf("отказ без допуска: rc=%d stdout=%s stderr=%s", rc, &out, &diagnostic)
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatalf("без допуска вызвана проба: %v", err)
	}

	t.Setenv("RUN_HOST_PREFLIGHT", "1")
	out.Reset()
	if rc := Run(args, &out, &diagnostic); rc != 0 ||
		!strings.Contains(out.String(), "host preflight готов") {
		t.Fatalf("metadata preflight: rc=%d stdout=%s stderr=%s", rc, &out, &diagnostic)
	}
	data, err := os.ReadFile(log)
	if err != nil || string(data) != "--version\n" {
		t.Fatalf("argv пробы=%q, ошибка=%v", data, err)
	}
}
