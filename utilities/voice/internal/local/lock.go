package local

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

type owner struct {
	PID       int    `json:"pid"`
	Starttime string `json:"starttime"`
	Token     string `json:"token"`
}

var lockBusy = voicecore.Failed("Установка уже идёт; повторите команду после её завершения.")

// acquireLock публикует полностью записанного владельца через rename каталога.
// Живой, неизвестный или подменённый владелец не удаляется из cache.
func acquireLock(directory string) (func(), error) {
	guard, err := lockGuard(directory)
	if err != nil {
		return nil, err
	}
	defer guard.Close()
	if err := retireLock(directory); err != nil {
		return nil, err
	}
	identity := owner{PID: os.Getpid(), Starttime: startTime(os.Getpid()), Token: voicecore.UUID()}
	if identity.Starttime == "" {
		return nil, voicecore.Failed("Не удалось определить владельца установки.")
	}
	pending, err := os.MkdirTemp(filepath.Dir(directory), ".install-lock-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(pending)
	data, _ := json.Marshal(identity)
	if err := os.WriteFile(filepath.Join(pending, "owner.json"), data, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(pending, directory); err != nil {
		return nil, lockBusy
	}
	return func() { releaseLock(directory, identity) }, nil
}

// lockGuard сериализует перенос и освобождение поколения блокировки, включая Darwin.
// Физический файл с inode-проверкой совместим с guard старого установщика на macOS.
func lockGuard(directory string) (*os.File, error) {
	path := directory + ".guard"
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, lockBusy
	}
	held, firstError := file.Stat()
	named, secondError := os.Lstat(path)
	if firstError != nil || secondError != nil || !held.Mode().IsRegular() || !os.SameFile(held, named) {
		file.Close()
		return nil, lockBusy
	}
	return file, nil
}

// retireLock отводит в отдельное имя только подтверждённо оставленную блокировку.
// Блокировку без owner или с неизвестным PID оставляет нетронутой.
func retireLock(directory string) error {
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.IsDir() {
		return lockBusy
	}
	identity, valid := readOwner(directory)
	if !valid || !knownDead(identity) {
		return lockBusy
	}
	again, err := os.Lstat(directory)
	current, valid := readOwner(directory)
	if err != nil || !valid || current != identity || !os.SameFile(info, again) {
		return lockBusy
	}
	tombstone := directory + ".stale-" + voicecore.UUID()
	if err := os.Rename(directory, tombstone); err != nil {
		return lockBusy
	}
	return os.RemoveAll(tombstone)
}

// releaseLock удаляет только каталог с тем же владельцем, который захватил installer.
// Ошибка проверки оставляет чужой или повреждённый lock на месте.
func releaseLock(directory string, current owner) {
	guard, err := lockGuard(directory)
	if err != nil {
		return
	}
	defer guard.Close()
	if identity, valid := readOwner(directory); valid && identity == current {
		_ = os.Remove(filepath.Join(directory, "owner.json"))
		_ = os.Remove(directory)
	}
}

// readOwner читает ограниченный JSON исключительно из обычного файла внутри каталога.
// Ownerless, symlink или ошибочные данные не являются доказательством смерти.
func readOwner(directory string) (owner, bool) {
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() {
		return owner{}, false
	}
	flags := os.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	file, err := os.OpenFile(filepath.Join(directory, "owner.json"), flags, 0)
	if err != nil {
		return owner{}, false
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return owner{}, false
	}
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	var result owner
	valid := err == nil && len(data) <= 4096 && json.Unmarshal(data, &result) == nil &&
		result.PID > 0 && result.Starttime != "" && result.Token != ""
	return result, valid
}

// knownDead различает исчезнувший PID и другое время старта под тем же номером.
// При невозможности подтвердить старт владелец остаётся неизвестным.
func knownDead(identity owner) bool {
	if err := syscall.Kill(identity.PID, 0); err != nil {
		return errors.Is(err, syscall.ESRCH)
	}
	if runtime.GOOS == "darwin" && !strings.HasPrefix(identity.Starttime, "darwin:") {
		return false
	}
	observed := startTime(identity.PID)
	return observed != "" && observed != identity.Starttime
}

// startTime читает время старта живого процесса по нативным данным системы.
// Linux сохраняет тот же формат starttime, что и прежний owner.json.
func startTime(pid int) string {
	if runtime.GOOS == "darwin" {
		data, err := exec.Command("/bin/ps", "-p", strconv.Itoa(pid), "-o", "lstart=").Output()
		if err != nil || strings.TrimSpace(string(data)) == "" {
			return ""
		}
		return "darwin:" + strings.TrimSpace(string(data))
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return ""
	}
	line := string(data)
	fields := strings.Fields(line[strings.LastIndex(line, ")")+1:])
	if len(fields) <= 19 {
		return ""
	}
	if fields[0] == "Z" {
		return "завершён"
	}
	return fields[19]
}
