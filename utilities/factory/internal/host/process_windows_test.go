package host

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestWindowsOwnedProcess(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "started")
	spec := Process{
		Path: program, Args: []string{"-test.run=^TestWindowsProcessFixture$"},
		Env:   append(os.Environ(), "GRIGDESK_WINDOWS_TEST_MARKER="+marker),
		Owned: true, Timeout: 10 * time.Second,
	}
	denied := errors.New("запуск запрещён тестом")
	spec.RecordOwner = func(owner TreeOwner) error {
		if !StillRunning(owner.Leader) {
			t.Error("владелец должен быть жив до выдачи разрешения")
		}
		return denied
	}
	if result := RunProcess(context.Background(), spec); result.RC == 0 || !errors.Is(result.Err, denied) {
		t.Fatalf("неожиданный отказ: %+v", result)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("код процесса выполнился до разрешения: %v", err)
	}

	spec.RecordOwner = nil
	result := RunProcess(context.Background(), spec)
	if result.RC != 0 || !result.OwnedTreeClosed {
		t.Fatalf("запуск или очистка Job не прошли: %+v", result)
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "started" {
		t.Fatalf("процесс не записал метку: %q, %v", raw, err)
	}

	spec.Env = append(spec.Env, "GRIGDESK_WINDOWS_TEST_HOLD=1")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result = RunProcess(ctx, spec)
	if result.RC != 124 || !result.OwnedTreeClosed {
		t.Fatalf("отмена не подтвердила закрытие Job: %+v", result)
	}
}

func TestWindowsProcessFixture(t *testing.T) {
	marker := os.Getenv("GRIGDESK_WINDOWS_TEST_MARKER")
	if marker == "" {
		return
	}
	if err := os.WriteFile(marker, []byte("started"), 0600); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("GRIGDESK_WINDOWS_TEST_HOLD") == "1" {
		time.Sleep(time.Minute)
	}
}

func TestWindowsProtectedFile(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	f, err := OpenAt(root, "value", os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600, ChangeMode)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString("value"); err != nil {
		t.Fatal(err)
	}
	if err := SetPrivateMode(f, 0400); err != nil {
		t.Fatal(err)
	}
	info, err := f.Stat()
	if err != nil || !SingleLink(f, info) || !PrivateMode(f, info, 0400) || PrivateMode(f, info, 0600) {
		t.Fatalf("не применён DACL immutable файла: %v", err)
	}
	if escaped, err := OpenAt(root, "..\\value", os.O_RDONLY, 0, 0); err == nil {
		escaped.Close()
		t.Fatal("разрешён выход за корень")
	}
}

func TestWindowsOrchestratorStop(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, "-test.run=^TestWindowsOrchestratorFixture$")
	cmd.Env = append(os.Environ(), "GRIGDESK_WINDOWS_TEST_CONTROL="+root)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()

	reader := bufio.NewReader(out)
	if first, err := reader.ReadString('\n'); err != nil || first != "ready\n" {
		t.Fatalf("начало оркестратора не подтверждено: %q, %v", first, err)
	}
	pid := strconv.Itoa(cmd.Process.Pid)
	if _, code := OrchestratorCommand([]string{"_windows-orchestrator", "stop", root, "3412", pid}); code == 0 {
		t.Fatal("задача с другим номером приняла запрос остановки")
	}
	if _, code := OrchestratorCommand([]string{"_windows-orchestrator", "status", root, "3411", pid}); code != 0 {
		t.Fatalf("оркестратор не найден: %d", code)
	}
	if _, code := OrchestratorCommand([]string{"_windows-orchestrator", "stop", root, "3411", pid}); code != 0 {
		t.Fatalf("событие остановки не принято: %d", code)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsOrchestratorFixture(t *testing.T) {
	root := os.Getenv("GRIGDESK_WINDOWS_TEST_CONTROL")
	if root == "" {
		return
	}
	ctx, closeEvent, err := OrchestratorContext(context.Background(), root, "3411")
	if err != nil {
		t.Fatal(err)
	}
	defer closeEvent()
	fmt.Println("ready")
	<-ctx.Done()
}
