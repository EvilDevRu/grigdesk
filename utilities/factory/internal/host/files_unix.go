//go:build unix

package host

import (
	"os"
	"syscall"
)

func fileFlags(flags int, options FileOptions) int {
	flags |= syscall.O_NOFOLLOW
	if options&Directory != 0 {
		flags |= syscall.O_DIRECTORY
	}
	if options&Nonblocking != 0 {
		flags |= syscall.O_NONBLOCK
	}
	return flags
}

func OpenAt(root *os.Root, name string, flags int, mode os.FileMode, options FileOptions) (*os.File, error) {
	return root.OpenFile(name, fileFlags(flags, options), mode)
}

func OpenPath(name string, flags int, mode os.FileMode, options FileOptions) (*os.File, error) {
	return os.OpenFile(name, fileFlags(flags, options), mode)
}

func FileOwner(_ *os.File, info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid())
}

func SingleLink(_ *os.File, info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}

func PrivateMode(_ *os.File, info os.FileInfo, mode os.FileMode) bool {
	return info.Mode().Perm() == mode
}

func SetPrivateMode(file *os.File, mode os.FileMode) error {
	return file.Chmod(mode)
}

func HasWritablePrivateMode(_ *os.File, info os.FileInfo) bool {
	return info.Mode().Perm()&0600 == 0600 && info.Mode().Perm()&^0664 == 0
}

func SyncDirectory(root *os.Root, name string) error {
	dir, err := OpenAt(root, name, os.O_RDONLY, 0, Directory)
	if err != nil {
		return err
	}
	defer dir.Close()

	return dir.Sync()
}

func RealFileOwner(_ *os.File, info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

func NativeSingleLink(info os.FileInfo) bool {
	return SingleLink(nil, info)
}

func Executable(_ string, info os.FileInfo) bool {
	return info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0
}
