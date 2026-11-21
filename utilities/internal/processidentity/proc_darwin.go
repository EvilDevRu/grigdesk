package processidentity

import (
	"errors"
	"fmt"

	"golang.org/x/sys/unix"
)

// Start сохраняет десятичные секунды и шесть цифр микросекунд, как прежний helper.
func Start(pid int) (string, bool) {
	if pid <= 0 {
		return "", false
	}
	if err := unix.Kill(pid, 0); errors.Is(err, unix.ESRCH) {
		return "", true
	}
	process, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || process.Proc.P_pid != int32(pid) {
		return "", false
	}
	if process.Proc.P_stat == 5 {
		return "", true
	}
	start := process.Proc.P_starttime
	if start.Sec <= 0 || start.Usec < 0 || start.Usec >= 1_000_000 {
		return "", false
	}
	return fmt.Sprintf("%d%06d", start.Sec, start.Usec), false
}
