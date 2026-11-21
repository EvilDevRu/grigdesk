package runner

import (
	"crypto/sha256"
	"os/exec"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/state"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// shellQuote экранирует путь для вставки в тестовый скрипт подмены.
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// fakeRunnerCLI создаёт подмену внешнего CLI. Каждое обращение дописывает
// построчный argv и сохраняет stdin; код возврата читается из файла <name>.rc,
// чтобы не протаскивать управление через окружение потомка. Тело body дополняет
// подмену выводом событий и файлов результата конкретного адаптера.
func fakeRunnerCLI(t *testing.T, dir, name, body string) string {
	t.Helper()
	binary := filepath.Join(dir, name)
	log := filepath.Join(dir, name+".calls")
	source := "#!/usr/bin/env bash\n" +
		"printf '%s\\n' \"$@\" >>" + shellQuote(log) + "\n" +
		"cat >" + shellQuote(log+".stdin") + "\n" +
		body + "\n" +
		"rc=$(cat " + shellQuote(log+".rc") + " 2>/dev/null || echo 0)\n" +
		"exit \"$rc\"\n"
	if err := os.WriteFile(binary, []byte(source), 0o755); err != nil {
		t.Fatal(err)
	}
	return binary
}

func TestMain(m *testing.M) {
	if handled, rc := host.PermitChild(os.Args[1:]); handled {
		os.Exit(rc)
	}
	os.Exit(m.Run())
}

// adapterFixture запускает только искусственный каталог и реально собранный status writer.
func adapterFixture(t *testing.T) Run {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	store := state.Store{StateDir: filepath.Join(dir, "state"), ControlDir: filepath.Join(dir, "control")}
	if err := os.Mkdir(store.StateDir, 0700); err != nil {
		t.Fatal(err)
	}
	routes := filepath.Join(dir, "routes")
	publisher := filepath.Join(repo, "tests", "engine", "fixtures", "routes-publish.mjs")
	runFixtureCommand(t, dir, "node", publisher, routes, "Offline fixture", "null")
	a, rc, err := store.BeginAttempt(state.BeginInput{
		Task: "8101", Profile: "demo-profile", RoutesDir: routes,
	})
	if rc != 0 || err != nil {
		t.Fatalf("fixture begin rc=%d: %v", rc, err)
	}
	if _, err := store.SelectRoute(a.Task, a.ID, "debug"); err != nil {
		t.Fatal(err)
	}
	id := state.RunIdentity{Task: a.Task, Attempt: a.ID, Stage: "BUILD", ID: "rfixture", Epoch: 1}
	token, rc, err := store.BeginRun(id)
	if rc != 0 || err != nil {
		t.Fatalf("fixture capability rc=%d: %v", rc, err)
	}
	runDir := filepath.Dir(store.StatusRequestDir(id))
	if err := os.MkdirAll(runDir, 0700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "factory")
	opts := []string{
		"-C", repo, "build", "-trimpath", "-o", binary, "./utilities/factory/cmd/factory",
	}
	runFixtureCommand(t, dir, "go", opts...)
	raw, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("factory writer %s SHA256=%x", binary, sha256.Sum256(raw))
	return Run{
		Store: store, Identity: id, Dir: runDir, Worktree: dir, Factory: binary, Capability: token,
		Environment: []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "FACTORY_FORBID_LIVE=1"},
		Timeout:     10 * time.Second, context: t.Context(),
	}
}

func runFixtureCommand(t *testing.T, dir, path string, args ...string) {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), path, args...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "LC_ALL=C",
		"GOTOOLCHAIN=local", "GOWORK=off", "GOCACHE=" + os.Getenv("GOCACHE")}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("подготовка %s: %v %s", path, err, out)
	}
}

const submitFixtureResult = `"$FACTORY_STATUS_BIN" stage-result --task "$FACTORY_RUN_TASK" \
--stage "$FACTORY_RUN_STAGE" --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" done`

func checkFixtureFile(t *testing.T, path string, contains ...string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range contains {
		if !strings.Contains(string(raw), value) {
			t.Fatalf("%s не содержит %q", path, value)
		}
	}
	return string(raw)
}
