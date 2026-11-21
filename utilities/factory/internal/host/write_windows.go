package host

import (
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// TrustedWriteCommand публикует ограниченный stdin под приватным DACL.
// Переименование внутри физического каталога не открывает существующий target для записи.
func TrustedWriteCommand(args []string, in io.Reader) (bool, int) {
	if len(args) > 0 && args[0] == "_windows-mkdir-protected" {
		if len(args) != 2 || ensureProtectedDirectory(args[1]) != nil {
			return true, 78
		}
		return true, 0
	}
	if len(args) == 0 || args[0] != "_windows-write-protected" {
		return false, 0
	}
	if len(args) != 2 || !filepath.IsAbs(args[1]) || filepath.Clean(args[1]) != args[1] {
		return true, 2
	}
	name := args[1]
	dir := filepath.Dir(name)
	if base := filepath.Base(name); !filepath.IsLocal(base) || strings.Contains(base, ":") {
		return true, 2
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil || resolved != dir {
		return true, 78
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return true, 78
	}
	defer root.Close()
	if err := publishProtectedFile(root, filepath.Base(name), in); err != nil {
		return true, 74
	}
	return true, 0
}

// ensureProtectedDirectory создаёт каталог сразу с закрытым DACL.
// Уже существующий каталог допускается только с теми же правами.
func ensureProtectedDirectory(name string) error {
	parent := filepath.Dir(name)
	physical, err := filepath.EvalSymlinks(parent)
	if err != nil || physical != parent || !filepath.IsAbs(name) || filepath.Clean(name) != name {
		return os.ErrInvalid
	}
	root, err := os.OpenRoot(parent)
	if err != nil {
		return err
	}
	defer root.Close()
	directory, err := OpenAt(root, filepath.Base(name), os.O_RDONLY|os.O_CREATE, 0700, Directory)
	if err != nil {
		return err
	}
	defer directory.Close()
	info, err := directory.Stat()
	if err != nil || !PrivateMode(directory, info, 0700) {
		return os.ErrPermission
	}
	return nil
}

// publishProtectedFile закрывает содержимое до атомарной смены имени.
// При отказе удаляется только временный файл операции.
func publishProtectedFile(root *os.Root, name string, in io.Reader) error {
	const limit = 128 * 1024 * 1024
	temporary := ".grigdesk-" + rand.Text()
	file, err := OpenAt(root, temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600, 0)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)

	size, err := io.Copy(file, io.LimitReader(in, limit+1))
	if err != nil || size > limit {
		file.Close()
		return errors.New("превышен допустимый размер, либо содержимое недоступно")
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return err
	}
	if current, err := root.Lstat(name); err == nil && !current.Mode().IsRegular() ||
		err != nil && !errors.Is(err, os.ErrNotExist) {
		return os.ErrInvalid
	}
	return root.Rename(temporary, name)
}
