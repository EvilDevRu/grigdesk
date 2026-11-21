package runner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
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
