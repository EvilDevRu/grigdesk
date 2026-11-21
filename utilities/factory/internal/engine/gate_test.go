package engine_test

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"grigdesk.local/tools/utilities/factory/internal/cli"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

func TestGateWorker(t *testing.T) {
	root := os.Getenv("FACTORY_TEST_GATE_ROOT")
	if root == "" {
		t.Skip("дочерний режим только с явным корнем")
	}
	barrier := os.NewFile(3, "release")
	var permit [1]byte
	if _, err := io.ReadFull(barrier, permit[:]); err != nil {
		t.Fatal(err)
	}
	barrier.Close()
	exact := os.Getenv("FACTORY_TEST_GATE_EXPECTED")
	decision := os.Getenv("FACTORY_TEST_GATE_DECISION")
	args := []string{
		testTask, "gate", "--profile", "demo-profile",
		"--routes-dir", filepath.Join(root, "routes"), "--state-dir", filepath.Join(root, "state"),
		"--control-dir", filepath.Join(root, "control"),
	}
	args = append(args, gateOptions(os.Getenv("FACTORY_TEST_GATE_ATTEMPT"), exact, decision)...)
	os.Exit(cli.Run(args, os.Stdout, os.Stderr))
}

func TestGateCompetingDecisions(t *testing.T) {
	f := newRouteFixture(t, false)
	f.expectStart(t, false)
	attempt := f.attempt(t)
	before, err := f.store.ReadStage(testTask, attempt)
	if err != nil {
		t.Fatal(err)
	}
	exact := fmt.Sprintf("%d:%s", before.Sequence, before.HeadEventHash)
	in, out, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	defer out.Close()
	a := startGateWriter(t, f, in, attempt, exact, "approved")
	b := startGateWriter(t, f, in, attempt, exact, "rejected")
	if _, err := out.Write([]byte{1, 1}); err != nil {
		t.Fatal(err)
	}
	first, second := a.wait(t), b.wait(t)
	if !(first == 0 && second == 75 || first == 75 && second == 0) {
		t.Fatalf("пара решений %d/%d, ожидались 0 и 75: %s / %s", first, second, a.output, b.output)
	}
	winner := "approved"
	if second == 0 {
		winner = "rejected"
	}
	next := f.assertGateCommit(t, attempt, before, winner)
	logDir := filepath.Join(f.store.StateDir, "logs")
	entries, err := os.ReadDir(logDir)
	if err != nil {
		t.Fatal(err)
	}
	var diagnostic string
	for _, entry := range entries {
		if !entry.IsDir() {
			raw, err := os.ReadFile(filepath.Join(logDir, entry.Name()))
			if err == nil {
				diagnostic += string(raw)
			}
		}
	}
	if !strings.Contains(diagnostic, "gate CAS не принят (код 75)") {
		t.Fatalf("нет записи об отказе gate: %s", diagnostic)
	}
	if rc, message := f.run(t, "gate", gateOptions(attempt, exact, winner)...); rc != 0 {
		t.Fatalf("дословный повтор решения: rc=%d %s", rc, message)
	}
	if again := f.assertGateCommit(t, attempt, before, winner); again != next {
		t.Fatal("дословный повтор записал второй переход")
	}
	t.Logf("gate rc=%d/%d, replay=0, head=%s", first, second, next.HeadEventHash)
}

func TestDecisionStale(t *testing.T) {
	f := newRouteFixture(t, false)
	f.expectStart(t, false)
	attempt := f.attempt(t)
	before, err := f.store.ReadStage(testTask, attempt)
	if err != nil {
		t.Fatal(err)
	}
	stale := fmt.Sprintf("%d:%s", before.Sequence-1, before.HeadEventHash)
	if rc, text := f.run(t, "gate", gateOptions(attempt, stale, "approved")...); rc != 75 {
		t.Fatalf("устаревший CAS rc=%d %s", rc, text)
	}
	if after, err := f.store.ReadStage(testTask, attempt); err != nil || after != before {
		t.Fatalf("устаревшее решение изменило cursor: %+v %v", after, err)
	}
	if f.projection(t)["GATE_ACCEPT"] != "waiting" {
		t.Fatal("устаревшее решение сняло ожидание")
	}
}

func gateOptions(attempt, expected, decision string) []string {
	return []string{"--attempt", attempt, "--node", "gate_accept", "--decision", decision,
		"--comment", "Сохранилось решение " + decision, "--commit-only", "--expected-stage", expected}
}

type gateWorker struct {
	command *exec.Cmd
	output  *bytes.Buffer
}

func startGateWriter(
	t *testing.T, f routeFixture, barrier *os.File, attempt, expected, decision string,
) gateWorker {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestGateWorker$")
	cmd.Env = append(f.launchEnvironment(),
		"FACTORY_TEST_GATE_ROOT="+f.dir, "FACTORY_TEST_GATE_ATTEMPT="+attempt,
		"FACTORY_TEST_GATE_EXPECTED="+expected, "FACTORY_TEST_GATE_DECISION="+decision,
		"GORACE=atexit_sleep_ms=0")
	cmd.ExtraFiles = []*os.File{barrier}
	out := new(bytes.Buffer)
	cmd.Stderr = out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	return gateWorker{cmd, out}
}

func (w gateWorker) wait(t *testing.T) int {
	t.Helper()
	err := w.command.Wait()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	if err != nil {
		t.Fatal(err)
	}
	return 0
}

func (f routeFixture) assertGateCommit(
	t *testing.T, attempt string, before state.StageSnapshot, winner string,
) state.StageSnapshot {
	t.Helper()
	cursor, err := f.store.ReadStage(testTask, attempt)
	if err != nil || cursor.Sequence != before.Sequence+1 || cursor.State != "stopped" {
		t.Fatalf("единственный gate commit отсутствует: %+v %v", cursor, err)
	}
	projection := f.projection(t)
	if projection["GATE_ACCEPT"] != winner || projection["ACCEPTANCE_DECISION"] != winner ||
		projection["GATE_ACCEPT_COMMENT"] != "Сохранилось решение "+winner {
		t.Fatalf("проекция победителя не сохранена: %+v", projection)
	}
	return cursor
}
