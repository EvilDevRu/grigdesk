package state

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type taskState struct {
	root *os.Root
	lock *os.File
}

var ErrConflict = errors.New("состояние попытки изменилось")

// openTask открывает тот же физический inode, который блокирует старый движок.
// При read-only пути не создаются, а режимы каталогов не изменяются.
func (s Store) openTask(task string, write bool) (*taskState, error) {
	if !taskPattern.MatchString(task) {
		return nil, fmt.Errorf("недопустимый номер задачи")
	}
	control, err := openControl(s.ControlDir, write)
	if err != nil {
		return nil, err
	}
	defer control.Close()

	parts := []string{"protocol-v2", "tasks", "t" + task}
	name := ""
	for _, part := range parts {
		name = filepath.Join(name, part)
		if err := ensurePrivateDirectory(control, name, write); err != nil {
			return nil, err
		}
	}
	dir, err := control.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	lock, err := dir.OpenFile(".", os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		dir.Close()
		return nil, err
	}
	operation := syscall.LOCK_SH
	if write {
		operation = syscall.LOCK_EX
	}
	if err := flock(lock, operation); err != nil {
		lock.Close()
		dir.Close()
		return nil, err
	}
	return &taskState{root: dir, lock: lock}, nil
}

func (t *taskState) close() {
	t.lock.Close()
	t.root.Close()
}

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

// openControl проверяет цепочку имени до открытия приватного корня.
// Создание происходит только на пути мутации с уже разрешённым физическим родителем.
func openControl(path string, create bool) (*os.Root, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == string(filepath.Separator) ||
		strings.ContainsAny(path, "\n\t") {
		return nil, fmt.Errorf("control-dir: нужен абсолютный канонический путь")
	}
	if create {
		parent := filepath.Dir(path)
		resolved, err := filepath.EvalSymlinks(parent)
		if err != nil || resolved != parent {
			return nil, fmt.Errorf("control-dir: родитель должен быть физическим каталогом")
		}
		if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if resolved != path {
		return nil, fmt.Errorf("control-dir: symlink-компоненты запрещены")
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	if err := ensurePrivateDirectory(root, ".", create); err != nil {
		root.Close()
		return nil, err
	}
	return root, nil
}

// ensurePrivateDirectory открывает физический каталог с проверкой владельца.
// Старый group-writable каталог сужается только под правом записи фабрики.
func ensurePrivateDirectory(root *os.Root, name string, create bool) error {
	if create && name != "." {
		if err := root.Mkdir(name, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
	}
	file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.IsDir() || !ownedByInvoker(info) {
		return fmt.Errorf("%s: чужой каталог control", name)
	}
	if info.Mode().Perm() != 0700 {
		if !create {
			return fmt.Errorf("%s: каталог control не приватный", name)
		}
		return file.Chmod(0700)
	}
	return nil
}

func ownedByInvoker(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid())
}

// readTrusted читает закрытый файл по проверенному открытому дескриптору.
// Размер, обычный тип, uid, mode и единственная ссылка обязательны.
func readTrusted(root *os.Root, name string, limit int64, mode fsMode) ([]byte, error) {
	file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || !ownedByInvoker(info) || !ok || stat.Nlink != 1 ||
		info.Size() > limit || !mode.accepts(info.Mode()) {
		return nil, fmt.Errorf("%s: недоверенный режим, владелец, тип или размер", name)
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s: файл превысил предел размера", name)
	}
	after, err := file.Stat()
	if err != nil {
		return nil, err
	}
	selected, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !sameTrustedFile(info, after, mode) || !sameTrustedFile(after, selected, mode) {
		return nil, fmt.Errorf("%s: физический файл изменился при чтении", name)
	}
	return data, nil
}

// sameTrustedFile сверяет inode и форму после чтения дескриптора.
// Подмена имени или добавление ссылки нарушает identity.
func sameTrustedFile(initial, actual os.FileInfo, mode fsMode) bool {
	stat, ok := actual.Sys().(*syscall.Stat_t)
	return ok && actual.Mode().IsRegular() && ownedByInvoker(actual) && stat.Nlink == 1 &&
		mode.accepts(actual.Mode()) && os.SameFile(initial, actual) &&
		initial.Size() == actual.Size() && initial.ModTime() == actual.ModTime()
}

type fsMode uint32

const (
	immutableMode    fsMode = 0400
	ownerMode        fsMode = 0600
	legacyProjection fsMode = 0664
)

func (mode fsMode) accepts(actual os.FileMode) bool {
	if mode == legacyProjection {
		// Старый Bash пишет витрину с umask оболочки внутри проверенного приватного state.
		return actual.Perm()&0600 == 0600 && actual.Perm()&^0664 == 0
	}
	return actual.Perm() == os.FileMode(mode)
}

// syncDirectory фиксирует публикацию имени после sync файла.
// Дескриптор каталога уже ограничен открытым os.Root.
func syncDirectory(root *os.Root, name string) error {
	dir, err := root.OpenFile(name, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// publishFile пишет временный файл в том же каталоге и фиксирует rename.
// Разрешение на replace выдаётся только проверившему своё состояние writer под lock.
func publishFile(root *os.Root, name string, data []byte, mode fsMode, replace bool) error {
	temporary := filepath.Join(filepath.Dir(name), ".factory-"+rand.Text())
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := errors.Join(file.Chmod(os.FileMode(mode)), file.Sync(), file.Close()); err != nil {
		return err
	}
	if !replace {
		if _, err := root.Lstat(name); !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%w: %s уже существует", ErrConflict, name)
		}
	}
	if err := root.Rename(temporary, name); err != nil {
		return err
	}
	return syncDirectory(root, filepath.Dir(name))
}
