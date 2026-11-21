package processidentity

import (
	"errors"
	"strconv"

	"golang.org/x/sys/windows"
)

// Start читает время создания процесса и проверяет его состояние по одному handle.
// Отказ в доступе оставляет владельца неизвестным, чтобы его запись не зачистили.
func Start(pid int) (string, bool) {
	if pid <= 0 || uint64(pid) > 1<<32-1 {
		return "", false
	}

	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE,
		false, uint32(pid))
	if err != nil {
		return "", errors.Is(err, windows.ERROR_INVALID_PARAMETER)
	}
	defer windows.CloseHandle(handle)

	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return "", false
	}
	state, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return "", false
	}
	if state == windows.WAIT_OBJECT_0 {
		return "", true
	}
	birth := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	if state != uint32(windows.WAIT_TIMEOUT) || birth == 0 {
		return "", false
	}

	return strconv.FormatUint(birth, 10), false
}
