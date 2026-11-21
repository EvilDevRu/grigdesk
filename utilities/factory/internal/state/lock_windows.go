package state

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

const (
	lockShared      = 0
	lockExclusive   = windows.LOCKFILE_EXCLUSIVE_LOCK
	lockNonblocking = windows.LOCKFILE_FAIL_IMMEDIATELY
)

func flock(file *os.File, operation int) error {
	var offset windows.Overlapped
	err := windows.LockFileEx(windows.Handle(file.Fd()), uint32(operation), 0, 1, 0, &offset)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return syscall.EWOULDBLOCK
	}

	return err
}

// openDirectoryLock оставляет отдельный файл в уже подтверждённом каталоге.
// Файл создаётся только writer, reader не меняет дерево.
func openDirectoryLock(root *os.Root, name string, write bool) (*os.File, error) {
	flags := os.O_RDONLY
	if write {
		flags = os.O_RDWR | os.O_CREATE
	}
	file, err := host.OpenAt(root, filepath.Join(name, ".factory.lock"), flags, 0600, 0)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !host.PrivateMode(file, info, 0600) || !host.SingleLink(file, info) {
		file.Close()
		return nil, errors.New("недопустимый файл блокировки каталога")
	}

	return file, nil
}
