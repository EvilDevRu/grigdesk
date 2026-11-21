package cli

import (
	"context"
	"errors"
	"io"
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

func nativeCommand(context.Context, []string, io.Writer) (int, bool) {
	return 0, false
}

// releaseInheritedWorkerDescriptors оставляет воркеру только штатные потоки 0–2
// и созданные в нём дескрипторы с CLOEXEC. Унаследованная труба AppImage
// удерживает старое FUSE-монтирование, а открытый образ скрывает владельца нового окна.
func releaseInheritedWorkerDescriptors() error {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		fd, err := strconv.Atoi(entry.Name())
		if err != nil || fd < 3 {
			continue
		}
		mark, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
		if errors.Is(err, unix.EBADF) {
			continue
		}
		if err != nil {
			return err
		}
		if mark&unix.FD_CLOEXEC == 0 {
			if err := unix.Close(fd); err != nil {
				return err
			}
		}
	}
	return nil
}
