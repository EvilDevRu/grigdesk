package installation

import (
	"errors"
	"os"
	"syscall"

	"grigdesk.local/tools/utilities/internal/processidentity"
)

// AcquireLock использует тот же kernel lease и inode, что и прежний установщик.
func AcquireLock(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, err
	}
	lease := processidentity.DarwinLease(int(file.Fd()))
	opened, statError := file.Stat()
	current, pathError := os.Lstat(path)
	if lease != 0 || statError != nil || pathError != nil || !os.SameFile(opened, current) {
		_ = file.Close()
		return nil, errors.New("installation_busy")
	}
	return func() { _ = file.Close() }, nil
}
