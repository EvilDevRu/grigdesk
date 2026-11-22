//go:build unix

package state

import (
	"errors"
	"os"
	"syscall"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

const (
	lockShared      = syscall.LOCK_SH
	lockExclusive   = syscall.LOCK_EX
	lockNonblocking = syscall.LOCK_NB
)

// flock повторяет только прерванный системный вызов на том же дескрипторе.
// Захваченная блокировка освобождается закрытием fd.
func flock(file *os.File, operation int) error {
	for {
		err := syscall.Flock(int(file.Fd()), operation)
		if !errors.Is(err, syscall.EINTR) {
			return err
		}
	}
}

func openDirectoryLock(root *os.Root, name string, _ bool) (*os.File, error) {
	return host.OpenAt(root, name, os.O_RDONLY, 0, host.Directory)
}
