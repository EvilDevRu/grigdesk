package state

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStageRaceAcrossProcesses(t *testing.T) {
	fixture := seedHistoricalAttempt(t)
	seedHistoricalStage(t, fixture)
	stage, err := fixture.store.ReadStage("51", fixture.active)
	if err != nil {
		t.Fatal(err)
	}
	barrier := makeWriterBarrier(t)
	first := startStageChild(t, fixture, stage, barrier, "race")
	second := startStageChild(t, fixture, stage, barrier, "race")
	barrier.await(t, 2)
	if _, err := barrier.permit.Write([]byte{1, 1}); err != nil {
		t.Fatal(err)
	}
	a, b := first.wait(), second.wait()
	if !(a == 0 && b == 75 || a == 75 && b == 0) {
		t.Fatalf("rs=[%d,%d], первый=%s второй=%s", a, b, first.output, second.output)
	}
	after, err := fixture.store.ReadStage("51", fixture.active)
	if err != nil || after.Sequence != stage.Sequence+1 || after.CurrentNode != "gate_plan" {
		t.Fatalf("writer сохранил неверный head: %+v %v", after, err)
	}
	t.Logf("два writer: rc=%d/%d, исходный SHA=%s, итоговый SHA=%s",
		a, b, stage.HeadEventHash, after.HeadEventHash)
}

func TestReceiptReconcileStageTail(t *testing.T) {
	fixture := seedHistoricalAttempt(t)
	seedHistoricalStage(t, fixture)
	stage, err := fixture.store.ReadStage("51", fixture.active)
	if err != nil {
		t.Fatal(err)
	}
	fixtureDir := filepath.Dir(fixture.store.ControlDir)
	tree := filepath.Join(fixtureDir, "workspace.snapshot")
	if err := os.WriteFile(tree, []byte("неизменяемый снимок вокруг одного эффекта\n"), 0600); err != nil {
		t.Fatal(err)
	}
	effect := filepath.Join(fixtureDir, "command.count")
	if err := os.WriteFile(effect, []byte("1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"51", fixture.active, "check", "done", "0", "", "0", "0", "0", "", "0"}
	receipt := PendingRequest{
		Task: "51", Attempt: fixture.active, Tree: tree,
		Sequence: stage.Sequence, ExpectedHead: stage.HeadEventHash, Args: args,
	}
	if err := fixture.store.PreparePending(receipt); err != nil {
		t.Fatal(err)
	}
	barrier := makeWriterBarrier(t)
	writer := startStageChild(t, fixture, stage, barrier, "crash")
	barrier.await(t, 1)
	if err := writer.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	writer.wait()

	before := stateFixtureHashes(t, fixture.store.ControlDir)
	if _, err := fixture.store.ReadStage("51", fixture.active); !errors.Is(err, ErrStagePending) {
		t.Fatalf("чтение приняло несовпадающий указатель: %v", err)
	}
	if after := stateFixtureHashes(t, fixture.store.ControlDir); !reflect.DeepEqual(before, after) {
		t.Fatal("read-only изменил хвост")
	}
	recovered, err := fixture.store.ReconcilePendingStage("51", fixture.active)
	if err != nil || recovered.Sequence != stage.Sequence+1 || recovered.CurrentNode != "gate_plan" {
		t.Fatalf("указатель не достроен: %+v %v", recovered, err)
	}
	retry, err := fixture.store.ReconcilePendingStage("51", fixture.active)
	if err != nil || retry != recovered {
		t.Fatalf("повтор изменил принятую цепочку: %+v %v", retry, err)
	}
	count, err := os.ReadFile(effect)
	if err != nil || string(count) != "1\n" {
		t.Fatalf("изменился счётчик эффекта: %q %v", count, err)
	}
	t.Logf("после SIGKILL восстановлен sequence=%d, SHA=%s, effects=1",
		recovered.Sequence, recovered.HeadEventHash)
}

type writerBarrier struct {
	ready, notify, allow, permit *os.File
}

// makeWriterBarrier выделяет отдельные каналы готовности и разрешения.
// Дочерний писатель сообщает об успешной физической операции до блокировки.
func makeWriterBarrier(t *testing.T) writerBarrier {
	t.Helper()
	ready, notify, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ready.Close()
		notify.Close()
	})
	allow, permit, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		allow.Close()
		permit.Close()
	})
	return writerBarrier{ready, notify, allow, permit}
}

// await ограничивает время подготовки, чтобы поломка стенда не считалась RED.
// Полученные байты означают, что дочерние процессы достигли заданной точки.
func (b writerBarrier) await(t *testing.T, count int) {
	t.Helper()
	if err := b.ready.SetReadDeadline(time.Now().Add(8 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(b.ready, make([]byte, count)); err != nil {
		t.Fatalf("барьер writer не достигнут: %v", err)
	}
}

type stageChild struct {
	cmd    *exec.Cmd
	output *bytes.Buffer
	done   bool
}

// startStageChild запускает уникальный экземпляр текущего тестового бинарника.
// Он получает только тестовые пути и тот же exact head для CAS.
func startStageChild(
	t *testing.T, fixture historicalFixture, stage StageSnapshot, barrier writerBarrier, mode string,
) *stageChild {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(t.Context(), binary)
	cmd.Env = []string{
		"FACTORY_TEST_STAGE_CHILD=" + mode, "TEST_CONTROL=" + fixture.store.ControlDir,
		"TEST_ATTEMPT=" + fixture.active, "TEST_SEQUENCE=" + strconv.FormatInt(stage.Sequence, 10),
		"TEST_HEAD=" + stage.HeadEventHash, "GORACE=atexit_sleep_ms=0",
	}
	cmd.ExtraFiles = []*os.File{barrier.notify, barrier.allow}
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
	return child
}

// wait получает исход только уже запущенного тестового процесса.
// Состояние done предотвращает повторное ожидание в cleanup.
func (p *stageChild) wait() int {
	err := p.cmd.Wait()
	p.done = true
	var status *exec.ExitError
	if errors.As(err, &status) {
		return status.ExitCode()
	}
	if err != nil {
		return 1
	}
	return 0
}

// runStageFixture применяет настоящий CAS или останавливается после публикации event.
// Ограничение находится только в тестовом publisher, production не читает эти env.
func runStageFixture(mode string) int {
	store := Store{ControlDir: os.Getenv("TEST_CONTROL")}
	sequence, _ := strconv.ParseInt(os.Getenv("TEST_SEQUENCE"), 10, 64)
	input := StageCommit{
		Task: "51", Attempt: os.Getenv("TEST_ATTEMPT"), Node: "check", Outcome: "done",
		ExpectedSequence: sequence, ExpectedHead: os.Getenv("TEST_HEAD"),
	}
	notify, allow := os.NewFile(3, "ready"), os.NewFile(4, "permit")
	defer notify.Close()
	defer allow.Close()
	pause := func() error {
		if _, err := notify.Write([]byte{1}); err != nil {
			return err
		}
		_, err := io.ReadFull(allow, make([]byte, 1))
		return err
	}
	var err error
	if mode == "race" {
		if err = pause(); err == nil {
			_, err = store.CommitStage(input)
		}
	} else if mode == "crash" {
		publish := func(root *os.Root, name string, data []byte, mode fsMode, replace bool) error {
			if err := publishFile(root, name, data, mode, replace); err != nil {
				return err
			}
			if strings.HasPrefix(name, "event.") {
				return pause()
			}
			return nil
		}
		_, err = store.commitStage(input, publish)
	} else {
		return 2
	}
	if err == nil {
		return 0
	}
	fmt.Fprintln(os.Stderr, err)
	if errors.Is(err, ErrConflict) {
		return 75
	}
	return 78
}
