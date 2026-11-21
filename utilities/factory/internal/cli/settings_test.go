package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestProfileRunnerSettings(t *testing.T) {
	root := t.TempDir()
	t.Setenv("FACTORY_PROFILES_DIR", root)
	dir := filepath.Join(root, "fixture")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "profile.sh"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	check := func(want int, output string, args ...string) {
		t.Helper()
		var out, stderr bytes.Buffer
		if got := Run(args, &out, &stderr); got != want || out.String() != output {
			t.Fatalf("%v: rc=%d, stdout=%q, stderr=%q", args, got, out.String(), stderr.String())
		}
	}
	check(0, "claude\ncodex\ndeepseek\nglm\nkimi\nqwen\n", "runners")
	check(78, "", "profile", "fixture", "runner", "set", "BUILD", "claude")
	check(0, "", "profile", "fixture", "runner", "set", "codex", "--failover", "claude,kimi")
	file := filepath.Join(dir, "runners.env")
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, append([]byte("# причина выбора\n"), raw...), 0600); err != nil {
		t.Fatal(err)
	}
	check(0, "", "profile", "fixture", "runner", "set", "BUILD", "deepseek")
	check(0, "fixture: codex -> claude,kimi\nBUILD: deepseek\n", "profile", "fixture", "runner", "show")
	check(0, "", "profile", "fixture", "model", "set", "BUILD", "deepseek", "exact=test")
	check(0, "BUILD/deepseek: exact=test\n", "profile", "fixture", "model", "show", "BUILD", "deepseek")
	check(2, "", "profile", "fixture", "model", "set", "BUILD", "deepseek", "exact=bad value")
	check(0, "", "profile", "fixture", "runner", "clear", "BUILD")
	raw, err = os.ReadFile(file)
	if err != nil || !bytes.HasPrefix(raw, []byte("# причина выбора\n")) ||
		!bytes.Contains(raw, []byte("CONFIG_REVISION=4\n")) {
		t.Fatalf("ревизия или комментарий потеряны: %q, %v", raw, err)
	}
}
