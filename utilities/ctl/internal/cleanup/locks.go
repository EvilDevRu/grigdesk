package cleanup

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"grigdesk.local/tools/utilities/internal/processidentity"
)

var lockSuffixes = []string{".lock", ".install-lock", ".select-lock", ".cutover-lock"}

type lockOwner struct {
	PID       int    `json:"pid"`
	Starttime string `json:"starttime"`
	Token     string `json:"token"`
}

func readOwner(directory *os.Root) lockOwner {
	file, err := directory.OpenFile("owner.json", os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return lockOwner{}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return lockOwner{}
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return lockOwner{}
	}
	var owner lockOwner
	if json.Unmarshal(data, &owner) != nil || owner.PID <= 0 || owner.Starttime == "" {
		return lockOwner{}
	}
	token, err := hex.DecodeString(owner.Token)
	if err != nil || len(token) != 16 {
		return lockOwner{}
	}
	return owner
}

// lockStatus различает подтверждённую смерть и закрытую ошибкой проверки блокировку.
func lockStatus(parent *os.Root, name string, self *lockOwner) string {
	stat, err := parent.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return ""
	}
	if err != nil || !stat.IsDir() {
		return "lock-unknown"
	}
	directory, err := childRoot(parent, name, stat)
	if err != nil {
		return "lock-unknown"
	}
	defer directory.Close()
	owner := readOwner(directory)
	if self != nil && self.PID > 0 && owner == *self {
		return ""
	}
	return ownerStatus(owner)
}

func ownerStatus(owner lockOwner) string {
	if owner.PID == 0 {
		return "lock-unknown"
	}
	identity, dead := processidentity.Start(owner.PID)
	if dead || identity != "" && identity != owner.Starttime {
		return ""
	}
	if identity == "" {
		return "lock-unknown"
	}
	return "locked"
}

func lockName(name string) bool {
	if name == "lock" {
		return true
	}
	for _, suffix := range lockSuffixes {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

type heldLock struct {
	parent *os.Root
	name   string
	owner  lockOwner
	inode  os.FileInfo
}

// acquireLock публикует owner.json в том же формате, который проверяет Node-разрешитель.
func acquireLock(parent *os.Root, name string) (*heldLock, string) {
	start, _ := processidentity.Start(os.Getpid())
	if start == "" {
		return nil, "lock-unknown"
	}
	for range 2 {
		err := parent.Mkdir(name, 0o700)
		if errors.Is(err, os.ErrExist) {
			status := lockStatus(parent, name, nil)
			if status != "" {
				return nil, status
			}
			if !retireDeadLock(parent, name) {
				return nil, "lock-unknown"
			}
			continue
		}
		if err != nil {
			return nil, "io-error"
		}
		inode, err := parent.Lstat(name)
		if err != nil {
			return nil, "lock-unknown"
		}
		directory, err := childRoot(parent, name, inode)
		if err != nil {
			return nil, "lock-unknown"
		}
		owner := lockOwner{PID: os.Getpid(), Starttime: start, Token: nonce()}
		data, _ := json.Marshal(owner)
		file, err := directory.OpenFile("owner.json", os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0o600)
		if err == nil {
			_, err = file.Write(data)
			if err == nil {
				err = file.Sync()
			}
			_ = file.Close()
		}
		_ = directory.Close()
		if err != nil {
			return nil, "lock-unknown"
		}
		return &heldLock{parent: parent, name: name, owner: owner, inode: inode}, ""
	}
	return nil, "lock-unknown"
}

func retireDeadLock(parent *os.Root, name string) bool {
	info, err := parent.Lstat(name)
	if err != nil {
		return errors.Is(err, os.ErrNotExist)
	}
	if lockStatus(parent, name, nil) != "" {
		return false
	}
	return relocateLock(parent, name, info, ".stale-"+nonce())
}

func (lock *heldLock) release() {
	directory, err := childRoot(lock.parent, lock.name, lock.inode)
	if err != nil {
		return
	}
	owner := readOwner(directory)
	_ = directory.Close()
	if owner == lock.owner {
		_ = relocateLock(lock.parent, lock.name, lock.inode, ".release-"+lock.owner.Token)
	}
}

func relocateLock(parent *os.Root, name string, info os.FileInfo, suffix string) bool {
	relocated := name + suffix
	if err := parent.Rename(name, relocated); err != nil {
		return false
	}
	current, err := parent.Lstat(relocated)
	if err != nil || !os.SameFile(info, current) {
		restore(parent, relocated, name)
		return false
	}
	return parent.RemoveAll(relocated) == nil
}

func restore(parent *os.Root, oldName, name string) {
	if _, err := parent.Lstat(name); errors.Is(err, os.ErrNotExist) {
		_ = parent.Rename(oldName, name)
	}
}

func lockAncestors(root *os.Root, outer *os.Root, rootName, path string, self *lockOwner) string {
	for path != "." {
		for _, suffix := range lockSuffixes {
			if state := lockStatus(root, path+suffix, self); state != "" {
				return state
			}
		}
		path = filepath.Dir(path)
	}
	for _, suffix := range lockSuffixes {
		if state := lockStatus(outer, rootName+suffix, self); state != "" {
			return state
		}
	}
	return ""
}

// HoldArtifact защищает запись одного производителя тем же owner, который читает уборка.
func HoldArtifact(target string) (func(), error) {
	before := func() bool {
		for ancestor := target; ancestor != "/"; ancestor = filepath.Dir(ancestor) {
			if _, err := os.Lstat(ancestor + ".cleanup.lock"); !errors.Is(err, os.ErrNotExist) {
				return false
			}
		}
		return true
	}
	if !filepath.IsAbs(target) || !before() {
		return nil, errors.New("Выполняется уборка артефактов.")
	}
	parent, err := os.OpenRoot(filepath.Dir(target))
	if err != nil {
		return nil, err
	}
	held, problem := acquireLock(parent, filepath.Base(target)+".lock")
	if problem != "" {
		_ = parent.Close()
		return nil, errors.New("Артефакт уже занят.")
	}
	release := func() {
		held.release()
		_ = parent.Close()
	}
	if !before() {
		release()
		return nil, errors.New("Выполняется уборка артефактов.")
	}
	return release, nil
}
