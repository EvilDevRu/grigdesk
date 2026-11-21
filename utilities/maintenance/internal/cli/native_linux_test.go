package cli

import (
	"errors"
	"os"
	"os/exec"
	"testing"

	"golang.org/x/sys/unix"
)

func TestReleaseInheritedWorkerDescriptors(t *testing.T) {
	const child = "GRIGDESK_TEST_WORKER_DESCRIPTORS"
	if os.Getenv(child) == "1" {
		read, write, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer read.Close()
		defer write.Close()
		directory, err := os.Open(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		defer directory.Close()
		if err := releaseInheritedWorkerDescriptors(); err != nil {
			t.Fatal(err)
		}
		for _, fd := range []uintptr{3, 4, 5, 6} {
			if _, err := unix.FcntlInt(fd, unix.F_GETFD, 0); !errors.Is(err, unix.EBADF) {
				t.Fatalf("воркер оставил открытым унаследованный дескриптор %d: %v", fd, err)
			}
		}
		for _, fd := range []uintptr{0, 1, 2, read.Fd(), write.Fd(), directory.Fd()} {
			if _, err := unix.FcntlInt(fd, unix.F_GETFD, 0); err != nil {
				t.Fatalf("закрыт нужный дескриптор %d: %v", fd, err)
			}
		}
		return
	}

	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	directory, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	image, err := os.CreateTemp(t.TempDir(), "GrigDesk")
	if err != nil {
		t.Fatal(err)
	}
	defer image.Close()
	probe := exec.Command(os.Args[0], "-test.run=^TestReleaseInheritedWorkerDescriptors$")
	probe.Env = append(os.Environ(), child+"=1")
	probe.ExtraFiles = []*os.File{write, read, image, directory}
	if output, err := probe.CombinedOutput(); err != nil {
		t.Fatalf("изоляция дескрипторов: %v\n%s", err, output)
	}
}
