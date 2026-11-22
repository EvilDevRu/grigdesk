package host

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

var orchestratorTask = regexp.MustCompile("^[1-9][0-9]{0,18}$")

// orchestratorEvent связывает Windows event с корнем, задачей и временем рождения процесса.
// При повторном использовании PID старое имя не адресует новый процесс.
func orchestratorEvent(root, task string, owner ProcessIdentity) (*uint16, error) {
	if !orchestratorTask.MatchString(task) || !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return nil, ErrUnconfirmedTree
	}
	physical, err := filepath.EvalSymlinks(root)
	if err != nil || physical != root {
		return nil, ErrUnconfirmedTree
	}
	digest := sha256.Sum256([]byte(physical + "\x00" + owner.Boot))
	name := fmt.Sprintf(`Local\GrigDesk.Factory.%x.%s.%d.%s`, digest, task, owner.PID, owner.Start)

	return windows.UTF16PtrFromString(name)
}

// OrchestratorContext отменяет работу по локальному событию Windows.
// Выполняющийся Launch завершает принадлежащий ему Job и публикует остановку штатным путём.
func OrchestratorContext(ctx context.Context, root, task string) (context.Context, func(), error) {
	owner, err := CurrentIdentity()
	if err != nil {
		return nil, nil, err
	}
	name, err := orchestratorEvent(root, task, owner)
	if err != nil {
		return nil, nil, err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, nil, err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" +
		user.User.Sid.String() + ")")
	if err != nil {
		return nil, nil, err
	}
	attrs := windows.SecurityAttributes{
		Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd,
	}
	event, err := windows.CreateEvent(&attrs, 1, 0, name)
	if err != nil {
		if event != 0 {
			windows.CloseHandle(event)
		}
		return nil, nil, err
	}

	child, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for child.Err() == nil {
			status, err := windows.WaitForSingleObject(event, 25)
			if err != nil || status != uint32(windows.WAIT_TIMEOUT) {
				cancel()
				return
			}
		}
	}()

	return child, func() {
		cancel()
		<-done
		windows.CloseHandle(event)
	}, nil
}

// OrchestratorCommand проверяет или сигналит только точный живой запуск.
// Дескрипторы события и процесса принадлежат ядру, сигнал PID здесь не используется.
func OrchestratorCommand(args []string) (bool, int) {
	if len(args) == 0 || args[0] != "_windows-orchestrator" {
		return false, 0
	}
	if len(args) != 5 || (args[1] != "status" && args[1] != "stop") {
		return true, 2
	}
	pid, err := strconv.Atoi(args[4])
	if err != nil || pid <= 0 || pid == os.Getpid() {
		return true, 2
	}
	owner, err := windowsIdentity(pid)
	if err != nil {
		return true, 1
	}
	name, err := orchestratorEvent(args[2], args[3], owner)
	if err != nil {
		return true, 78
	}
	access := uint32(windows.SYNCHRONIZE)
	if args[1] == "stop" {
		access |= windows.EVENT_MODIFY_STATE
	}
	event, err := windows.OpenEvent(access, false, name)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return true, 1
	}
	if err != nil {
		return true, 78
	}
	defer windows.CloseHandle(event)
	if !StillRunning(owner) {
		return true, 1
	}
	if args[1] == "stop" && windows.SetEvent(event) != nil {
		return true, 78
	}

	return true, 0
}
