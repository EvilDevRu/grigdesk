package host

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestProcessLockWindows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "factory.lock")
	holder, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()

	contender, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer contender.Close()

	if err := TryProcessLock(holder); err != nil {
		t.Fatal(err)
	}
	if err := TryProcessLock(contender); !errors.Is(err, syscall.EWOULDBLOCK) {
		t.Fatalf("ожидался конфликт, получено %v", err)
	}
	if err := holder.Close(); err != nil {
		t.Fatal(err)
	}
	if err := TryProcessLock(contender); err != nil {
		t.Fatalf("блокировка не освободилась после закрытия: %v", err)
	}
}
