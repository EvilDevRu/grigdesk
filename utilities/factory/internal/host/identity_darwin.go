package host

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type darwinIdentity struct {
	PID    int    `json:"pid"`
	PPID   int    `json:"ppid"`
	UID    int    `json:"uid"`
	Group  int    `json:"pgid"`
	SID    int    `json:"sid"`
	Start  string `json:"starttime"`
	Status string `json:"state"`
}

// trustedDarwinHelper разрешает только проверенный helper выбранной установки.
// Для probe проверяются физический путь, режим, число ссылок и SHA до exec.
func trustedDarwinHelper() (string, error) {
	path := os.Getenv("FACTORY_DARWIN_PROCESS_HELPER")
	expected := os.Getenv("FACTORY_DARWIN_PROCESS_HELPER_SHA256")
	if !filepath.IsAbs(path) || len(expected) != 64 || filepath.Clean(path) != path {
		return "", ErrUnconfirmedTree
	}
	actual, err := filepath.EvalSymlinks(path)
	if err != nil || actual != path {
		return "", ErrUnconfirmedTree
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 8*1024*1024 ||
		info.Mode().Perm()&0022 != 0 || info.Mode().Perm()&0111 == 0 {
		return "", ErrUnconfirmedTree
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st.Nlink != 1 || (st.Uid != 0 && int(st.Uid) != os.Geteuid()) {
		return "", ErrUnconfirmedTree
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, io.LimitReader(file, 8*1024*1024+1)); err != nil {
		return "", err
	}
	visible, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, visible) || hex.EncodeToString(hash.Sum(nil)) != expected {
		return "", ErrUnconfirmedTree
	}
	return path, nil
}

func darwinProbe(args ...string) ([]byte, error) {
	helper, err := trustedDarwinHelper()
	if err != nil {
		return nil, err
	}
	result := RunProcess(context.Background(), Process{
		Path: helper, Args: args, Timeout: 2 * time.Second, Limit: 2 * 1024 * 1024,
	})
	if result.RC == 3 {
		return nil, errNoProcess
	}
	if result.RC != 0 || result.OutputOverflow {
		return nil, fmt.Errorf("%w: Darwin probe rc=%d", ErrUnconfirmedTree, result.RC)
	}
	return result.Stdout, nil
}

func bootID() (string, error) {
	data, err := darwinProbe("boot-id")
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(data))
	if len(id) != 36 {
		return "", ErrUnconfirmedTree
	}
	return id, nil
}

func readIdentity(pid int, boot string) (ProcessIdentity, error) {
	raw, err := darwinProbe("identity", strconv.Itoa(pid))
	if err != nil {
		return ProcessIdentity{}, err
	}
	var item darwinIdentity
	if json.Unmarshal(raw, &item) != nil || item.PID != pid ||
		item.UID != os.Geteuid() || item.SID <= 0 || item.Start == "" {
		return ProcessIdentity{}, ErrUnconfirmedTree
	}
	return item.identity(boot), nil
}

func (item darwinIdentity) identity(boot string) ProcessIdentity {
	return ProcessIdentity{PID: item.PID, PPID: item.PPID, Group: item.Group,
		Session: item.SID, UID: item.UID, Start: item.Start, Boot: boot, State: item.Status}
}

func sessionMembers(sid int, boot string) ([]ProcessIdentity, error) {
	raw, err := darwinProbe("uid-census")
	if err != nil {
		return nil, err
	}
	var items []darwinIdentity
	if json.Unmarshal(raw, &items) != nil || items == nil {
		return nil, ErrUnconfirmedTree
	}
	var result []ProcessIdentity
	for _, item := range items {
		if item.SID == sid {
			item.UID = os.Geteuid()
			result = append(result, item.identity(boot))
		}
	}
	return result, nil
}

func signalIdentity(item ProcessIdentity, signal syscall.Signal) error {
	var name string
	switch signal {
	case syscall.SIGTERM:
		name = "TERM"
	case syscall.SIGCONT:
		name = "CONT"
	case syscall.SIGKILL:
		name = "KILL"
	default:
		return ErrUnconfirmedTree
	}
	pid, sid, group := strconv.Itoa(item.PID), strconv.Itoa(item.Session), strconv.Itoa(item.Group)
	_, err := darwinProbe("signal-stage-member", pid, item.Start, sid, group, name)
	if err == errNoProcess {
		return nil
	}
	return err
}
