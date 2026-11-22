package state

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/host"
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
	lock, err := openDirectoryLock(dir, ".", write)
	if err != nil {
		dir.Close()
		return nil, err
	}
	operation := lockShared
	if write {
		operation = lockExclusive
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

// openControl проверяет цепочку имени до открытия приватного корня.
// Создание происходит только на пути мутации с уже разрешённым физическим родителем.
func openControl(path string, create bool) (*os.Root, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Dir(path) == path ||
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
	options := host.Directory
	if create {
		options |= host.ChangeMode
	}
	file, err := host.OpenAt(root, name, os.O_RDONLY, 0, options)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.IsDir() || !host.FileOwner(file, info) {
		return fmt.Errorf("%s: чужой каталог control", name)
	}
	if !host.PrivateMode(file, info, 0700) {
		if !create {
			return fmt.Errorf("%s: каталог control не приватный", name)
		}
		return host.SetPrivateMode(file, 0700)
	}
	return nil
}

// readTrusted читает закрытый файл по проверенному открытому дескриптору.
// Размер, обычный тип, uid, mode и единственная ссылка обязательны.
func readTrusted(root *os.Root, name string, limit int64, mode fsMode) ([]byte, error) {
	file, err := host.OpenAt(root, name, os.O_RDONLY, 0, host.Nonblocking)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !host.FileOwner(file, info) || !host.SingleLink(file, info) ||
		info.Size() > limit || !mode.accepts(file, info) {
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
	if !sameTrustedFile(file, info, after, mode) || !sameTrustedFile(file, after, selected, mode) {
		return nil, fmt.Errorf("%s: физический файл изменился при чтении", name)
	}
	return data, nil
}

// sameTrustedFile сверяет inode и форму после чтения дескриптора.
// Подмена имени или добавление ссылки нарушает identity.
func sameTrustedFile(file *os.File, initial, actual os.FileInfo, mode fsMode) bool {
	return actual.Mode().IsRegular() && host.FileOwner(file, actual) && host.SingleLink(file, actual) &&
		mode.accepts(file, actual) && os.SameFile(initial, actual) &&
		initial.Size() == actual.Size() && initial.ModTime() == actual.ModTime()
}

type fsMode uint32

const (
	immutableMode    fsMode = 0400
	ownerMode        fsMode = 0600
	legacyProjection fsMode = 0664
)

func (mode fsMode) accepts(file *os.File, actual os.FileInfo) bool {
	if mode == legacyProjection {
		// Старый Bash пишет витрину с umask оболочки внутри проверенного приватного state.
		return host.HasWritablePrivateMode(file, actual)
	}
	return host.PrivateMode(file, actual, os.FileMode(mode))
}

// publishFile пишет временный файл в том же каталоге и фиксирует rename.
// Разрешение на replace выдаётся только проверившему своё состояние writer под lock.
func publishFile(root *os.Root, name string, data []byte, mode fsMode, replace bool) error {
	temporary := filepath.Join(filepath.Dir(name), ".factory-"+rand.Text())
	file, err := host.OpenAt(root, temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600, host.ChangeMode)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := errors.Join(host.SetPrivateMode(file, os.FileMode(mode)), file.Sync(), file.Close()); err != nil {
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
	return host.SyncDirectory(root, filepath.Dir(name))
}
