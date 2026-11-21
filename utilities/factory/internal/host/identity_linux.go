package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func bootID() (string, error) {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(data))
	if len(id) != 36 {
		return "", ErrUnconfirmedTree
	}
	return id, nil
}

// readIdentity читает stat одной proc записи и сверяет владельца inode.
// Имя процесса до последней закрывающей скобки может содержать пробелы и скобки.
func readIdentity(pid int, boot string) (ProcessIdentity, error) {
	if pid <= 0 {
		return ProcessIdentity{}, ErrUnconfirmedTree
	}
	dir := filepath.Join("/proc", strconv.Itoa(pid))
	root, err := os.OpenRoot(dir)
	if procGone(err) {
		return ProcessIdentity{}, errNoProcess
	}
	if err != nil {
		return ProcessIdentity{}, err
	}
	defer root.Close()
	info, err := root.Stat(".")
	if procGone(err) {
		return ProcessIdentity{}, errNoProcess
	}
	if err != nil {
		return ProcessIdentity{}, err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ProcessIdentity{}, ErrUnconfirmedTree
	}
	raw, err := root.ReadFile("stat")
	if procGone(err) {
		return ProcessIdentity{}, errNoProcess
	}
	if err != nil {
		return ProcessIdentity{}, err
	}
	return parseProcStat(pid, int(owner.Uid), boot, string(raw))
}

func procGone(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ESRCH)
}

func parseProcStat(pid, uid int, boot, raw string) (ProcessIdentity, error) {
	end := strings.LastIndex(raw, ") ")
	if end < 1 || !strings.HasPrefix(raw, strconv.Itoa(pid)+" (") {
		return ProcessIdentity{}, ErrUnconfirmedTree
	}
	fields := strings.Fields(raw[end+2:])
	if len(fields) < 20 || len(fields[0]) != 1 {
		return ProcessIdentity{}, ErrUnconfirmedTree
	}
	ppid, ppidErr := strconv.Atoi(fields[1])
	group, groupErr := strconv.Atoi(fields[2])
	session, sessionErr := strconv.Atoi(fields[3])
	epoch, epochErr := strconv.ParseUint(fields[19], 10, 64)
	if ppidErr != nil || groupErr != nil || sessionErr != nil || epochErr != nil || epoch == 0 {
		return ProcessIdentity{}, ErrUnconfirmedTree
	}
	return ProcessIdentity{
		PID: pid, PPID: ppid, Group: group, Session: session,
		UID: uid, Boot: boot, Start: fields[19], State: fields[0],
	}, nil
}

// sessionMembers собирает текущие записи сессии и переживает завершение процесса при обходе.
// Ошибка чтения, кроме доказанного исчезновения, блокирует сигнал.
func sessionMembers(sid int, boot string) ([]ProcessIdentity, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var result []ProcessIdentity
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || !entry.IsDir() {
			continue
		}
		item, err := readIdentity(pid, boot)
		if errors.Is(err, errNoProcess) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("%w: proc census PID %d: %v", ErrUnconfirmedTree, pid, err)
		}
		if item.Session == sid {
			result = append(result, item)
		}
	}
	return result, nil
}

// Linux использует общие номера pidfd на поддерживаемых amd64 и arm64.
// Повторное использование числового PID не меняет цель уже открытого pidfd.
const (
	linuxPidfdSendSignal = 424
	linuxPidfdOpen       = 434
)

func signalIdentity(expected ProcessIdentity, signal syscall.Signal) error {
	fd, _, errno := syscall.Syscall(linuxPidfdOpen, uintptr(expected.PID), 0, 0)
	if errno == syscall.ESRCH {
		return nil
	}
	if errno != 0 {
		return fmt.Errorf("%w: pidfd_open: %v", ErrUnconfirmedTree, errno)
	}
	defer syscall.Close(int(fd))
	actual, err := readIdentity(expected.PID, expected.Boot)
	if errors.Is(err, errNoProcess) {
		return nil
	}
	if err != nil || !sameProcess(actual, expected) {
		return ErrUnconfirmedTree
	}
	_, _, errno = syscall.Syscall6(linuxPidfdSendSignal, fd, uintptr(signal), 0, 0, 0, 0)
	if errno != 0 && errno != syscall.ESRCH {
		return fmt.Errorf("%w: pidfd_send_signal: %v", ErrUnconfirmedTree, errno)
	}
	return nil
}
