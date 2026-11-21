package installation

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"

	"grigdesk.local/tools/utilities/internal/processidentity"
)

type FileProof struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Mode   uint32 `json:"mode"`
}

type Identity struct {
	Dev uint64 `json:"dev"`
	Ino uint64 `json:"ino"`
}

func FileIdentity(info os.FileInfo) Identity {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return Identity{}
	}
	return Identity{Dev: uint64(stat.Dev), Ino: uint64(stat.Ino)}
}

func UUID() string {
	var value [16]byte
	_, _ = rand.Read(value[:])
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:])
}

func ReadOrdinary(path string, maximum int64) ([]byte, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maximum {
		return nil, errors.New("installation_file_invalid")
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(data)) > maximum {
		return nil, errors.New("installation_file_invalid")
	}
	return data, nil
}

// ProveFile измеряет обычный файл, полученный из ожидаемого inode без перехода по ссылке.
func ProveFile(path string) (FileProof, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return FileProof{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !owned(info) {
		return FileProof{}, errors.New("installation_file_invalid")
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(file, info.Size()+1))
	if err != nil || count != info.Size() {
		return FileProof{}, errors.New("installation_file_changed")
	}
	return FileProof{Size: count, SHA256: hex.EncodeToString(hash.Sum(nil)), Mode: uint32(info.Mode().Perm())}, nil
}

func SyncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func JSONBytes(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	canonical, err := CanonicalJSON(raw)
	if err != nil {
		return nil, err
	}
	return append(canonical, '\n'), nil
}

// PublishFile создаёт новое имя или принимает те же байты и права при повторе.
func PublishFile(path string, bytes []byte, mode os.FileMode) error {
	proof := FileProof{Size: int64(len(bytes)), SHA256: Hash(bytes), Mode: uint32(mode)}
	if pinned, err := ProveFile(path); err == nil {
		if pinned == proof {
			return nil
		}
		return errors.New("installation_publish_conflict")
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("installation_publish_conflict")
	}
	if err := writeTemporary(path, bytes, mode, false); err != nil {
		if errors.Is(err, os.ErrExist) {
			pinned, inspect := ProveFile(path)
			if inspect == nil && pinned == proof {
				return nil
			}
		}
		return err
	}
	return nil
}

// ReplaceState меняет приватный файл атомарно под блокировкой вызывающего.
func ReplaceState(path string, bytes []byte) error {
	return writeTemporary(path, bytes, 0o600, true)
}

func writeTemporary(path string, bytes []byte, mode os.FileMode, replace bool) error {
	parent := filepath.Dir(path)
	file, err := os.CreateTemp(parent, ".grigdesk-publish-*")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if _, err := file.Write(bytes); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if replace {
		err = os.Rename(temp, path)
	} else {
		err = os.Link(temp, path)
	}
	if err != nil {
		return err
	}
	return SyncDirectory(parent)
}

// CheckParents отклоняет ссылки и обычные файлы в структурных каталогах.
func CheckParents(path string) error {
	if !safeAbsolute(path) {
		return errors.New("installation_input_invalid")
	}
	prefix := "/"
	for _, name := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		prefix = filepath.Join(prefix, name)
		info, err := os.Lstat(prefix)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil || !info.IsDir() {
			return errors.New("installation_path_invalid")
		}
	}
	return nil
}

// MoveNoReplace публикует staging под тем же физическим родителем, не затирая чужое имя.
func MoveNoReplace(from, to string) error {
	info, err := os.Lstat(filepath.Dir(from))
	if err != nil {
		return err
	}
	return MoveNoReplaceAt(from, to, FileIdentity(info))
}

func MoveNoReplaceAt(from, to string, parentID Identity) error {
	if filepath.Dir(from) != filepath.Dir(to) {
		return errors.New("installation_move_parent_mismatch")
	}
	parent := filepath.Dir(from)
	fd, err := unix.Open(parent, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil ||
		(Identity{Dev: uint64(stat.Dev), Ino: uint64(stat.Ino)}) != parentID {
		return errors.New("installation_parent_changed")
	}
	if err := renameNoReplace(fd, filepath.Base(from), fd, filepath.Base(to)); err != nil {
		return err
	}
	return unix.Fsync(fd)
}

// MoveOwnedDirectory привязывает перенос к проверенному inode и держит оба родителя открытыми.
func MoveOwnedDirectory(from, to string, expected Identity) error {
	if err := CheckParents(filepath.Dir(from)); err != nil {
		return err
	}
	if err := CheckParents(filepath.Dir(to)); err != nil {
		return err
	}
	source, err := unix.Open(filepath.Dir(from), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(source)
	destination, err := unix.Open(filepath.Dir(to), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(destination)
	var stat unix.Stat_t
	name := filepath.Base(from)
	if err := unix.Fstatat(source, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil ||
		stat.Mode&unix.S_IFMT != unix.S_IFDIR || stat.Mode&0o022 != 0 || int(stat.Uid) != os.Getuid() ||
		(Identity{Dev: uint64(stat.Dev), Ino: uint64(stat.Ino)}) != expected {
		return errors.New("installation_move_identity_mismatch")
	}
	if err := renameNoReplace(source, name, destination, filepath.Base(to)); err != nil {
		return err
	}
	return errors.Join(unix.Fsync(source), unix.Fsync(destination))
}

type owner struct {
	PID       int    `json:"pid"`
	Starttime string `json:"starttime"`
	Token     string `json:"token"`
}

func readOwner(path string) owner {
	data, err := ReadOrdinary(filepath.Join(path, "owner.json"), 4096)
	if err != nil {
		return owner{}
	}
	var result owner
	if json.Unmarshal(data, &result) != nil {
		return owner{}
	}
	return result
}

// AcquireLock использует существующий wire owner.json для Linux и Darwin.
func acquireDirectoryLock(path string) (func(), error) {
	start, _ := processidentity.Start(os.Getpid())
	if start == "" {
		return nil, errors.New("installation_lock_identity_unknown")
	}
	staging := path + ".prepare-" + UUID()
	if err := os.Mkdir(staging, 0o700); err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	current := owner{PID: os.Getpid(), Starttime: start, Token: strings.ReplaceAll(UUID(), "-", "")}
	content, _ := JSONBytes(current)
	if err := PublishFile(filepath.Join(staging, "owner.json"), content, 0o600); err != nil {
		return nil, err
	}
	for range 2 {
		err := MoveNoReplace(staging, path)
		if err == nil {
			return func() {
				if readOwner(path) == current {
					_ = relocateLock(path, ".release-"+current.Token, current)
				}
			}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		old := readOwner(path)
		identity, dead := processidentity.Start(old.PID)
		if old.PID <= 0 || old.Starttime == "" || old.Token == "" ||
			!dead && (identity == "" || identity == old.Starttime) ||
			!relocateLock(path, ".stale-"+current.Token, old) {
			return nil, errors.New("installation_busy")
		}
	}
	return nil, errors.New("installation_busy")
}

func relocateLock(path, suffix string, expected owner) bool {
	before, err := os.Lstat(path)
	if err != nil || !before.IsDir() || !owned(before) || readOwner(path) != expected {
		return false
	}
	target := path + suffix
	if err := MoveNoReplace(path, target); err != nil {
		return false
	}
	observed, err := os.Lstat(target)
	if err != nil || !os.SameFile(before, observed) || readOwner(target) != expected {
		_ = MoveNoReplace(target, path)
		return false
	}
	if err := os.RemoveAll(target); err != nil {
		return false
	}
	return SyncDirectory(filepath.Dir(path)) == nil
}
