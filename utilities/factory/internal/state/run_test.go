package state

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestStageResult(t *testing.T) {
	fixture := seedHistoricalAttempt(t)
	binary := buildStatusFixture(t)
	id := RunIdentity{Task: "51", Attempt: fixture.active, Stage: "BUILD", ID: "candidate-a", Epoch: 1}
	token, rc, err := fixture.store.BeginRun(id)
	if rc != 0 || err != nil || token == "" {
		t.Fatalf("не опубликован active run: rc=%d %v", rc, err)
	}
	tokenFile := statusTokenFile(t, token)
	barrier := makeWriterBarrier(t)
	first := startStatusFixture(t, binary, fixture, id, tokenFile, barrier, "stage-result", "done")
	second := startStatusFixture(t, binary, fixture, id, tokenFile, barrier, "stage-result", "failed")
	barrier.await(t, 2)
	if _, err := barrier.permit.Write([]byte{1, 1}); err != nil {
		t.Fatal(err)
	}
	a, b := first.wait(), second.wait()
	if !(a == 0 && b == 75 || a == 75 && b == 0) {
		t.Fatalf("два terminal writer: rc=%d/%d, %s / %s", a, b, first.output, second.output)
	}
	newID := id
	newID.ID, newID.Epoch = "candidate-b", 2
	newToken, rc, err := fixture.store.BeginRun(newID)
	if rc != 0 || err != nil || newToken == token {
		t.Fatalf("новая эпоха не получила отдельное право: rc=%d %v", rc, err)
	}
	if rc, output := callStatus(t, binary, fixture, id, tokenFile, "stage-result", "done"); rc != 73 {
		t.Fatalf("предыдущее право: rc=%d %s", rc, output)
	}
	newRun, rc, err := fixture.store.ReadRun(newID)
	if rc != 0 || err != nil || newRun.State != "active" {
		t.Fatalf("новая эпоха повреждена: %+v, rc=%d %v", newRun, rc, err)
	}
	t.Logf("terminal rc=%d/%d, устаревшее право rc=73, epoch=%d active", a, b, newID.Epoch)
}

func TestStageProgress(t *testing.T) {
	fixture := seedHistoricalAttempt(t)
	binary := buildStatusFixture(t)
	id := RunIdentity{Task: "51", Attempt: fixture.active, Stage: "PLAN", ID: "progress-a", Epoch: 1}
	token, rc, err := fixture.store.BeginRun(id)
	if rc != 0 || err != nil {
		t.Fatalf("не опубликован active run: rc=%d %v", rc, err)
	}
	good, bad := statusTokenFile(t, token), statusTokenFile(t, "wrong-secret")
	checks := []struct {
		file       *os.File
		key, value string
		rc         int
	}{
		{good, "PLANS", "done", 0}, {good, "ROUTE_BY", "human", 2}, {good, "PLAN", "done", 2},
		{good, "SIZE", "XL", 2}, {nil, "SIZE", "S", 74}, {bad, "SIZE", "S", 74},
	}
	for _, check := range checks {
		rc, output := callStatus(t, binary, fixture, id, check.file, "stage-progress", check.key, check.value)
		if rc != check.rc {
			t.Errorf("progress %s=%s: rc=%d, ожидался %d: %s", check.key, check.value, rc, check.rc, output)
		}
	}
	file := filepath.Join(fixture.store.StateDir, "t51.pipeline")
	forged := []byte("PLAN=done\nROUTE_BY=human\nACTIVE_RUN_PLAN=forged\n")
	if err := os.WriteFile(file, forged, 0600); err != nil {
		t.Fatal(err)
	}
	before := stateFixtureHashes(t, filepath.Dir(fixture.store.StateDir))
	active, rc, err := fixture.store.ReadRun(id)
	if err != nil || rc != 0 || active.State != "active" {
		t.Fatalf("проекция подменила active run: %+v rc=%d %v", active, rc, err)
	}
	if !reflect.DeepEqual(before, stateFixtureHashes(t, filepath.Dir(fixture.store.StateDir))) {
		t.Fatal("read-only изменил состояние")
	}
}

func TestDeferred(t *testing.T) {
	fixture := seedHistoricalAttempt(t)
	binary := buildStatusFixture(t)
	id := RunIdentity{Task: "51", Attempt: fixture.active, Stage: "LEAD", ID: "deferred-a", Epoch: 1}
	token, rc, err := fixture.store.BeginRun(id)
	if rc != 0 || err != nil {
		t.Fatalf("не опубликован active run: rc=%d %v", rc, err)
	}
	dir := filepath.Join(fixture.store.StateDir, "logs", "runs", "t51", id.Stage, id.ID, "control-requests")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	cmd := statusFixture(t, binary, fixture, id, "stage-result",
		"--finding-deferred", "outside=Вне цели <>&", "done", "проверено")
	cmd.Env = append(cmd.Env,
		"FACTORY_STATUS_MODE=request", "FACTORY_STATUS_REQUEST_DIR="+dir, "FACTORY_CONTROL_ROOT=")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("deferred writer не принял валидную заявку: %v %s", err, output)
	}
	assertRunState(t, fixture.store, id, "active", "")
	oracle := historicalInput(t, "verdict.txt")
	if rc, err := fixture.store.ConsumeStatusRequests(id, token); rc != 0 || err != nil {
		t.Fatalf("host не принял заявку: rc=%d %v", rc, err)
	}
	assertRunState(t, fixture.store, id, "committed", "done")
	accepted, _, err := fixture.store.ReadRun(id)
	if err != nil || accepted.Verdict != strings.TrimSpace(string(oracle)) {
		t.Fatalf("вердикт отличается от байтов Bash: %s %v", accepted.Verdict, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("принятая заявка осталась в очереди: %v %v", entries, err)
	}
}

// assertRunState сверяет независимый state reader перед и после решения хоста.
func assertRunState(t *testing.T, store Store, id RunIdentity, mode, result string) {
	t.Helper()
	run, rc, err := store.ReadRun(id)
	if rc != 0 || err != nil || run.State != mode || run.Result != result {
		t.Fatalf("run: %+v, rc=%d %v, ожидалось %s/%s", run, rc, err, mode, result)
	}
}

// buildStatusFixture проверяет свежую внешнюю команду. Сбой сборки является сбоем стенда.
func buildStatusFixture(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "factory")
	cmd := exec.CommandContext(t.Context(), "go", "build", "-trimpath", "-o", binary, "./cmd/factory")
	cmd.Dir = filepath.Join("..", "..")
	cmd.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOWORK=off")
	if data, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("сборка status fixture: %v %s", err, data)
	}
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("status writer %s SHA256=%x", binary, sha256.Sum256(data))
	return binary
}

// statusFixture передаёт только временные пути, точный контекст и аргументы операции.
func statusFixture(
	t *testing.T, binary string, fixture historicalFixture, id RunIdentity, verb string, args ...string,
) *exec.Cmd {
	t.Helper()
	epoch := strconv.FormatUint(id.Epoch, 10)
	argv := []string{verb, "--task", id.Task, "--stage", id.Stage, "--run-id", id.ID, "--epoch", epoch}
	cmd := exec.CommandContext(t.Context(), binary, append(argv, args...)...)
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"), "LC_ALL=C", "HOME=" + filepath.Dir(fixture.store.StateDir),
		"FACTORY_CONTROL_ROOT=" + fixture.store.ControlDir, "FACTORY_STATE=" + fixture.store.StateDir,
		"FACTORY_RUN_TASK=" + id.Task, "FACTORY_RUN_STAGE=" + id.Stage, "FACTORY_RUN_ID=" + id.ID,
		"FACTORY_RUN_EPOCH=" + epoch, "FACTORY_RUN_ATTEMPT=" + id.Attempt, "FACTORY_STATUS_FD=3",
	}
	return cmd
}

// statusTokenFile имитирует повторно читаемое право, доступное лишь через fd.
func statusTokenFile(t *testing.T, token string) *os.File {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), ".token-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { file.Close() })
	if _, err := file.WriteString(token + "\n"); err != nil {
		t.Fatal(err)
	}
	return file
}

func callStatus(
	t *testing.T, binary string, fixture historicalFixture, id RunIdentity, token *os.File,
	verb string, args ...string,
) (int, string) {
	t.Helper()
	cmd := statusFixture(t, binary, fixture, id, verb, args...)
	if token != nil {
		cmd.ExtraFiles = []*os.File{token}
	}
	output, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), string(output)
	}
	if err != nil {
		t.Fatal(err)
	}
	return 0, string(output)
}

// startStatusFixture ставит настоящие CLI writers за общим pipe-барьером.
func startStatusFixture(
	t *testing.T, binary string, fixture historicalFixture, id RunIdentity, token *os.File,
	barrier writerBarrier, verb, result string,
) *stageChild {
	t.Helper()
	desired := statusFixture(t, binary, fixture, id, verb, result)
	source := `printf r >&4 && read -r -N 1 <&5 && exec "$@"`
	barrierArgs := []string{"--noprofile", "--norc", "-c", source, "status-fixture"}
	cmd := exec.CommandContext(t.Context(), "bash", append(barrierArgs, desired.Args...)...)
	cmd.Env = desired.Env
	cmd.ExtraFiles = []*os.File{token, barrier.notify, barrier.allow}
	child := &stageChild{cmd: cmd, output: &bytes.Buffer{}}
	cmd.Stderr = child.output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !child.done {
			_ = child.cmd.Process.Kill()
			child.wait()
		}
	})
	if strings.Contains(strings.Join(desired.Args, " "), token.Name()) {
		t.Fatal("путь к праву попал в argv")
	}
	return child
}
