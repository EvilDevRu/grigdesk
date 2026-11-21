package processidentity

import (
	"errors"
	"io/fs"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// Start возвращает идентичность рождения процесса и явный признак смерти.
func Start(pid int) (string, bool) {
	if pid <= 0 {
		return "", false
	}
	if err := unix.Kill(pid, 0); errors.Is(err, unix.ESRCH) {
		return "", true
	}
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", errors.Is(err, fs.ErrNotExist)
	}
	text := string(data)
	last := strings.LastIndex(text, ")")
	if last < 0 {
		return "", false
	}
	fields := strings.Fields(text[last+1:])
	if len(fields) <= 19 {
		return "", false
	}
	if fields[0] == "Z" {
		return "", true
	}
	if _, err := strconv.ParseUint(fields[19], 10, 64); err != nil {
		return "", false
	}
	return fields[19], false
}
