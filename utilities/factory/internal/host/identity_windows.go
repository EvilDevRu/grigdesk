package host

import (
	"os"

	"golang.org/x/sys/windows"

	"grigdesk.local/tools/utilities/internal/processidentity"
)

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

	return ProcessIdentity{
		PID: pid, Group: pid, Session: pid, Start: birth, Boot: "windows:" + owner.User.Sid.String(),
	}, nil
}

func CurrentIdentity() (ProcessIdentity, error) {
	return windowsIdentity(os.Getpid())
}

func StillRunning(expected ProcessIdentity) bool {
	current, err := windowsIdentity(expected.PID)

	return err == nil && current.Start == expected.Start && current.Boot == expected.Boot
}
