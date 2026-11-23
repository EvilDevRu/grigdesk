package host

import (
	"context"
	"os"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"grigdesk.local/tools/utilities/internal/processidentity"
)

type windowsBootEnvironment struct {
	identifier windows.GUID
	firmware   uint32
	flags      uint64
}

// windowsBootID читает идентификатор текущей загрузки из ядра.
// Один GUID используется во всех событиях lifecycle и процессах одной загрузки.
var windowsBootID = sync.OnceValues(func() (string, error) {
	var info windowsBootEnvironment
	err := windows.NtQuerySystemInformation(windows.SystemBootEnvironmentInformation,
		unsafe.Pointer(&info), uint32(unsafe.Sizeof(info)), nil)
	if err != nil {
		return "", err
	}
	if info.identifier == (windows.GUID{}) {
		return "", ErrUnconfirmedTree
	}

	return strings.ToLower(strings.Trim(info.identifier.String(), "{}")), nil
})

// windowsIdentity связывает PID и время создания с владельцем токена процесса.
// Чужой или неподтверждённый процесс не считается активным исполнителем.
func windowsIdentity(pid int) (ProcessIdentity, error) {
	birth, dead := processidentity.Start(pid)
	if dead || birth == "" {
		return ProcessIdentity{}, ErrUnconfirmedTree
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ProcessIdentity{}, err
	}
	defer windows.CloseHandle(handle)

	var token windows.Token
	if err := windows.OpenProcessToken(handle, windows.TOKEN_QUERY, &token); err != nil {
		return ProcessIdentity{}, err
	}
	defer token.Close()

	owner, err := token.GetTokenUser()
	if err != nil {
		return ProcessIdentity{}, err
	}
	self, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || !owner.User.Sid.Equals(self.User.Sid) {
		return ProcessIdentity{}, ErrUnconfirmedTree
	}
	confirmed, dead := processidentity.Start(pid)
	if dead || confirmed != birth {
		return ProcessIdentity{}, ErrUnconfirmedTree
	}
	boot, err := windowsBootID()
	if err != nil {
		return ProcessIdentity{}, err
	}

	return ProcessIdentity{
		PID: pid, Group: pid, Session: pid, Start: birth, Boot: boot,
	}, nil
}

func CurrentIdentity() (ProcessIdentity, error) {
	return windowsIdentity(os.Getpid())
}

func StillRunning(expected ProcessIdentity) bool {
	current, err := windowsIdentity(expected.PID)

	return err == nil && current.Start == expected.Start && current.Boot == expected.Boot
}

// CurrentBootID читает идентификатор загрузки Windows для графовых резерваций.
var CurrentBootID = func() (string, error) {
	return windowsBootID()
}

// CaptureTree на Windows не подтверждает сессию графового владельца.
// Графовый модельный порт первой поставки работает на Linux и Darwin.
func CaptureTree(pid int) (TreeOwner, error) {
	return TreeOwner{}, ErrUnconfirmedTree
}

// StopTree на Windows не управляет графовыми сессиями.
func StopTree(ctx context.Context, owner TreeOwner, grace time.Duration) error {
	return ErrUnconfirmedTree
}

// TreeExitConfirmed на Windows не подтверждает выход графового scope.
func TreeExitConfirmed(owner TreeOwner) (bool, error) {
	return false, ErrUnconfirmedTree
}
