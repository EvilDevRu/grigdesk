package host

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestAndroidSupervisorAfterLeaderExit(t *testing.T) {
	checkAndroidSupervisor(t, "exit", 0)
}

func TestAndroidSupervisorCancellation(t *testing.T) {
	checkAndroidSupervisor(t, "wait", 124)
}

// checkAndroidSupervisor подтверждает очистку потомка, создавшего собственную сессию.
// Соседний процесс остаётся доступен после окончания контролируемого запуска.
func checkAndroidSupervisor(t *testing.T, mode string, expected int) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	neighbor := exec.Command(executable, "-test.run=^TestAndroidOwnedFixture$")
	neighbor.Env = append(os.Environ(), "FACTORY_ANDROID_FIXTURE=grandchild")
	if err := neighbor.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = neighbor.Process.Kill()
		_ = neighbor.Wait()
	}()

	pidFile := filepath.Join(t.TempDir(), "descendant")
	spec := Process{
		Path: executable, Args: []string{"-test.run=^TestAndroidOwnedFixture$"},
		Env:   append(os.Environ(), "FACTORY_ANDROID_FIXTURE="+mode, "FACTORY_ANDROID_PID_FILE="+pidFile),
		Owned: true, Timeout: time.Second,
	}
	result := RunProcess(t.Context(), spec)
	if result.RC != expected || !result.OwnedTreeClosed {
		t.Fatalf("владение не закрыто: код=%d, %v, stderr=%s", result.RC, result.Err, result.Stderr)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(raw))
	if err != nil || pid <= 1 || !errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
		t.Fatalf("потомок остался жив: %s, %v", raw, err)
	}
	if err := syscall.Kill(neighbor.Process.Pid, 0); err != nil {
		t.Fatalf("соседний процесс затронут: %v", err)
	}
}

// TestAndroidOwnedFixture создаёт дочерний процесс в отдельной сессии.
// Потомок остаётся жив, пока его не остановит супервизор тестового запуска.
func TestAndroidOwnedFixture(t *testing.T) {
	mode := os.Getenv("FACTORY_ANDROID_FIXTURE")
	if mode == "" {
		return
	}
	if mode == "grandchild" {
		time.Sleep(30 * time.Second)
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable, "-test.run=^TestAndroidOwnedFixture$")
	child.Env = append(os.Environ(), "FACTORY_ANDROID_FIXTURE=grandchild")
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	pidFile := os.Getenv("FACTORY_ANDROID_PID_FILE")
	if err := os.WriteFile(pidFile, []byte(strconv.Itoa(child.Process.Pid)), 0600); err != nil {
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatal(err)
	}
	if mode == "wait" {
		_ = child.Wait()
	}
}
