//go:build linux

package host

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if handled, rc := PermitChild(os.Args[1:]); handled {
		os.Exit(rc)
	}
	os.Exit(m.Run())
}

func TestStopOwnedTree(t *testing.T) {
	target := startTestTree(t, "running")
	neighbor := startTestTree(t, "running")
	owner, err := CaptureTree(target.pid)
	if err != nil {
		t.Fatalf("нет доказательства собственной сессии: %v", err)
	}
	forged := owner
	forged.Leader.Start += "0"
	if err := StopTree(t.Context(), forged, 150*time.Millisecond); !errors.Is(err, ErrUnconfirmedTree) {
		t.Fatalf("ошибочный start token не отклонён: %v", err)
	}
	assertProcessAlive(t, target.pid)
	assertProcessAlive(t, neighbor.pid)
	start := time.Now()
	if err := StopTree(t.Context(), owner, 150*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	target.wait(t)
	if err := StopTree(t.Context(), owner, 150*time.Millisecond); err != nil {
		t.Fatalf("повтор cancel: %v", err)
	}
	assertProcessAlive(t, neighbor.pid)
	t.Logf("своя сессия подтверждённо остановлена за %s, соседняя жива", time.Since(start))
}

func TestStopAfterLeaderExit(t *testing.T) {
	target := startTestTree(t, "leader-exits")
	neighbor := startTestTree(t, "running")
	owner, err := CaptureTree(target.pid)
	if err != nil {
		t.Fatalf("нет доказательства участников: %v", err)
	}
	if _, err := target.permit.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	target.wait(t)
	assertProcessAlive(t, target.descendant)
	// Повторный coordinator получает только сериализованное доказательство.
	raw, err := json.Marshal(owner)
	if err != nil {
		t.Fatal(err)
	}
	var reloaded TreeOwner
	if err := json.Unmarshal(raw, &reloaded); err != nil {
		t.Fatal(err)
	}
	if err := StopTree(t.Context(), reloaded, 150*time.Millisecond); err != nil {
		t.Fatalf("остановка после выхода лидера: %v", err)
	}
	assertProcessAlive(t, neighbor.pid)
}

func TestStopBeforePermit(t *testing.T) {
	pending := startTestTree(t, "held")
	neighbor := startTestTree(t, "running")
	owner, err := CaptureTree(pending.pid)
	if err != nil {
		t.Fatalf("wrapper ожидал permit без подтверждённой identity: %v", err)
	}
	if err := StopTree(t.Context(), owner, 150*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	pending.wait(t)
	if data := pending.effect.Bytes(); len(data) != 0 {
		t.Fatalf("сработал эффект до permit: %q", data)
	}
	assertProcessAlive(t, neighbor.pid)
}

func TestStopManagedPermit(t *testing.T) {
	var observed TreeOwner
	denied := RunProcess(t.Context(), Process{
		Path: "/bin/sh", Args: []string{"-c", "printf effect"}, Owned: true,
		RecordOwner: func(owner TreeOwner) error {
			observed = owner
			return ErrUnconfirmedTree
		},
	})
	if denied.RC != 78 || observed.Leader.PID == 0 || len(denied.Stdout) != 0 {
		t.Fatalf("до регистрации сработал эффект: rc=%d output=%q", denied.RC, denied.Stdout)
	}
	if err := StopTree(t.Context(), observed, 150*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	allowed := RunProcess(t.Context(), Process{
		Path: "/bin/sh", Args: []string{"-c", "printf effect"}, Owned: true,
	})
	if allowed.RC != 0 || string(allowed.Stdout) != "effect" {
		t.Fatalf("permit не исполнил точную команду: rc=%d, %q %v", allowed.RC, allowed.Stdout, allowed.Err)
	}
}

type fixtureTree struct {
	cmd             *exec.Cmd
	pid, descendant int
	permit          *os.File
	effect          *bytes.Buffer
}

func startTestTree(t *testing.T, behavior string) fixtureTree {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ready, notify, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer ready.Close()
	defer notify.Close()
	allow, permit, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer allow.Close()
	t.Cleanup(func() { permit.Close() })
	cmd := exec.Command(binary, "-test.run=^TestHostFixture$")
	cmd.Env = []string{"FACTORY_TEST_HOST_FIXTURE=" + behavior, "GORACE=atexit_sleep_ms=0"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.ExtraFiles = []*os.File{notify, allow}
	effect := new(bytes.Buffer)
	cmd.Stdout = effect
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// Только уникальная сессия, порождённая этой фикстурой.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	})
	notify.Close()
	ready.SetReadDeadline(time.Now().Add(5 * time.Second))
	var descendant int
	if _, err := fmt.Fscan(ready, &descendant); err != nil {
		t.Fatalf("не достигнут pipe-барьер: %v", err)
	}
	return fixtureTree{cmd, cmd.Process.Pid, descendant, permit, effect}
}

func (f fixtureTree) wait(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- f.cmd.Wait() }()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("свой лидер не завершился")
	}
}

func assertProcessAlive(t *testing.T, pid int) {
	t.Helper()
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("тестовый pid=%d исчез: %v", pid, err)
	}
}

// TestHostFixture формирует только подконтрольную тесту сессию.
// Дочерний процесс наследует stderr, а permit проходит по отдельному pipe.
func TestHostFixture(t *testing.T) {
	mode := os.Getenv("FACTORY_TEST_HOST_FIXTURE")
	if mode == "" {
		return
	}
	if mode == "member" {
		for {
			time.Sleep(time.Hour)
		}
	}
	ready := os.NewFile(3, "ready")
	allow := os.NewFile(4, "permit")
	defer ready.Close()
	defer allow.Close()
	if mode == "held" {
		fmt.Fprintln(ready, "0")
		var permit [1]byte
		if _, err := io.ReadFull(allow, permit[:]); err == nil && permit[0] == 1 {
			fmt.Fprintln(os.Stdout, "effect")
		}
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestHostFixture$")
	cmd.Env = []string{"FACTORY_TEST_HOST_FIXTURE=member", "GORACE=atexit_sleep_ms=0"}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	fmt.Fprintln(ready, strconv.Itoa(cmd.Process.Pid))
	if mode == "leader-exits" {
		var trigger [1]byte
		_, _ = allow.Read(trigger[:])
		os.Exit(0)
	}
	_ = cmd.Wait()
}

// TestCaptureTreeRefusesOwnSession доказывает инвариант detached-вызова model-open.
// Собственная сессия не захватывается, дочерняя сессия подтверждается с PPID владельца.
func TestCaptureTreeRefusesOwnSession(t *testing.T) {
	if _, err := CaptureTree(os.Getpid()); !errors.Is(err, ErrUnconfirmedTree) {
		t.Fatalf("захват собственной сессии запрещён: %v", err)
	}
	child := exec.Command("sleep", "30")
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = child.Process.Kill()
		_ = child.Wait()
	}()
	owner, err := CaptureTree(child.Process.Pid)
	if err != nil {
		t.Fatalf("дочерняя сессия захватывается: %v", err)
	}
	if owner.Leader.PPID != os.Getpid() || owner.Leader.Session != owner.Leader.PID {
		t.Fatalf("лидер подтверждён с PPID владельца и своей сессией: %+v", owner.Leader)
	}
}

// TestRunProcessOwnedDeadlineClosesTree доказывает, что дедлайн owned-пробы
// останавливает всю сессию: зависший лидер и его потомок не переживают тайм-аут,
// а результат прямо сообщает о подтверждённом закрытии дерева.
func TestRunProcessOwnedDeadlineClosesTree(t *testing.T) {
	var observed TreeOwner
	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	result := RunProcess(ctx, Process{
		Path: "/bin/sh", Args: []string{"-c", "sleep 60 & wait"}, Owned: true,
		RecordOwner: func(owner TreeOwner) error {
			observed = owner
			return nil
		},
	})
	if result.RC != 124 || !result.OwnedTreeClosed || result.Err == nil {
		t.Fatalf("дедлайн не закрыл сессию: rc=%d closed=%t err=%v", result.RC, result.OwnedTreeClosed, result.Err)
	}
	closed, err := TreeExitConfirmed(observed)
	if err != nil || !closed {
		t.Fatalf("после дедлайна в сессии остались процессы: closed=%t err=%v", closed, err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("дедлайн завершил пробу поздно: %s", elapsed)
	}
}

// TestRunProcessOwnedCancelClosesTree доказывает то же для отмены контекста:
// код возврата 130, дерево закрыто, читатель lease не остаётся в живой сессии.
func TestRunProcessOwnedCancelClosesTree(t *testing.T) {
	var observed TreeOwner
	marker := filepath.Join(t.TempDir(), "started")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan ProcessResult, 1)
	go func() {
		done <- RunProcess(ctx, Process{
			Path: "/bin/sh", Args: []string{"-c", "touch " + marker + "; sleep 60 & wait"}, Owned: true,
			RecordOwner: func(owner TreeOwner) error {
				observed = owner
				return nil
			},
		})
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("фикстура не достигла запуска")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	result := <-done
	if result.RC != 130 || !result.OwnedTreeClosed || result.Err == nil {
		t.Fatalf("отмена не закрыла сессию: rc=%d closed=%t err=%v", result.RC, result.OwnedTreeClosed, result.Err)
	}
	closed, err := TreeExitConfirmed(observed)
	if err != nil || !closed {
		t.Fatalf("после отмены в сессии остались процессы: closed=%t err=%v", closed, err)
	}
}
