package host

import (
	"os"
	"syscall"
)

// TryProcessLock получает тот же kernel flock, что native helper Darwin.
func TryProcessLock(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
