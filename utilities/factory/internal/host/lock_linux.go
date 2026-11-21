package host

import (
	"os"
	"syscall"
)

// TryProcessLock получает неблокирующий kernel flock на удерживаемом fd.
func TryProcessLock(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
