package processidentity

import (
	"os"
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsStart(t *testing.T) {
	start, dead := Start(os.Getpid())
	if start == "" || dead {
		t.Fatalf("текущий процесс не опознан: %q, завершён: %t", start, dead)
	}
	if again, dead := Start(os.Getpid()); again != start || dead {
		t.Fatalf("признак рождения изменился: %q, завершён: %t", again, dead)
	}

	child := exec.Command(os.Args[0], "-test.run=^$")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}

	handle, openErr := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(child.Process.Pid))
	if openErr == nil {
		defer windows.CloseHandle(handle)
	}
	if err := child.Wait(); err != nil {
		t.Fatal(err)
	}
	if openErr != nil {
		t.Fatal(openErr)
	}
	if birth, dead := Start(child.Process.Pid); !dead || birth != "" {
		t.Fatalf("выход дочернего процесса не подтвердился: %q, завершён: %t", birth, dead)
	}
}
