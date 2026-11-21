package processidentity

import (
	"context"
	"debug/macho"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"golang.org/x/sys/unix"
)

//go:embed darwin-process-identity.asset
var darwinHelper []byte

type DarwinIdentity struct {
	PID        int    `json:"pid"`
	PPID       int    `json:"ppid"`
	PGID       int    `json:"pgid"`
	SID        int    `json:"sid"`
	UID        int    `json:"uid"`
	Starttime  string `json:"starttime"`
	State      string `json:"state"`
	Executable string `json:"executable"`
}

func InspectDarwin(ctx context.Context, pid int) (DarwinIdentity, int) {
	if pid <= 0 {
		return DarwinIdentity{}, 74
	}
	if _, dead := Start(pid); dead {
		return DarwinIdentity{}, 3
	}
	if len(darwinHelper) < 32 || len(darwinHelper) > 8<<20 ||
		binary.LittleEndian.Uint32(darwinHelper) != macho.Magic64 ||
		binary.LittleEndian.Uint32(darwinHelper[4:]) != uint32(macho.CpuArm64) ||
		binary.LittleEndian.Uint32(darwinHelper[12:]) != uint32(macho.TypeExec) {
		return DarwinIdentity{}, 74
	}
	dir, err := os.MkdirTemp("", "grigdesk-process-")
	if err != nil {
		return DarwinIdentity{}, 74
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "process-identity")
	if err := os.WriteFile(file, darwinHelper, 0o500); err != nil {
		return DarwinIdentity{}, 74
	}
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	command := exec.CommandContext(bounded, file, "identity", strconv.Itoa(pid))
	command.Env = []string{}
	command.Dir = "/"
	content, err := command.Output()
	if err != nil {
		var status *exec.ExitError
		if errors.As(err, &status) && status.ExitCode() == 3 {
			return DarwinIdentity{}, 3
		}
		return DarwinIdentity{}, 74
	}
	var result DarwinIdentity
	if len(content) > 8192 || json.Unmarshal(content, &result) != nil || result.PID != pid ||
		result.UID != os.Getuid() || result.Starttime == "" || !filepath.IsAbs(result.Executable) {
		return DarwinIdentity{}, 74
	}
	return result, 0
}

func DarwinUIDPIDs() ([]int, error) {
	list, err := unix.SysctlKinfoProcSlice("kern.proc.uid", os.Getuid())
	if err != nil || len(list) > 65536 {
		return nil, errors.New("release_process_owner_invalid")
	}
	var result []int
	for _, process := range list {
		if process.Proc.P_pid > 0 && process.Proc.P_stat != 5 {
			result = append(result, int(process.Proc.P_pid))
		}
	}
	return result, nil
}

// DarwinLease закрепляет flock за тем же open file description, который держит родитель.
func DarwinLease(fd int) int {
	var info unix.Stat_t
	if unix.Fstat(fd, &info) != nil || info.Mode&unix.S_IFMT != unix.S_IFREG ||
		info.Mode&0o7777 != 0o600 || info.Nlink != 1 || info.Uid != uint32(os.Getuid()) {
		return 74
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) {
			return 75
		}
		return 74
	}
	return 0
}
