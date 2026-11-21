package host

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// TryProcessLock захватывает первый байт файла до закрытия дескриптора.
// Конфликт возвращается сразу и сохраняет общий код повторной попытки.
func TryProcessLock(file *os.File) error {
	const flags = windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY
	var offset windows.Overlapped
	err := windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, &offset)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return syscall.EWOULDBLOCK
	}
	return err
}
