package host

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type jobAccounting struct {
	TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
}

var getProcessIDOfThread = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetProcessIdOfThread")

func PermitChild(args []string) (bool, int) {
	if len(args) > 0 && args[0] == "_factory-permit-exec" {
		return true, 126
	}

	return false, 0
}

// runOwnedProcess помещает приостановленный процесс в закрытый Job Object.
// Команда получает управление только после регистрации владельца, а выход подтверждается по всему Job.
func runOwnedProcess(ctx context.Context, spec Process) (ProcessResult, error) {
	if len(spec.Files) != 0 || spec.BeforePermit != nil {
		return ProcessResult{RC: 78}, errors.New("Windows: запуск требует режима очереди и профиля без Linux-браузера")
	}
	if err := ctx.Err(); err != nil {
		return ProcessResult{RC: 130}, err
	}
	job, err := newProcessJob()
	if err != nil {
		return ProcessResult{RC: 78}, err
	}
	defer func() {
		if job != 0 {
			windows.CloseHandle(job)
		}
	}()

	cmd := exec.Command(spec.Path, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = append([]string{}, spec.Env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW}
	cmd.WaitDelay = 500 * time.Millisecond
	stdout, stderr := newProcessOutput(spec.Limit), newProcessOutput(spec.Limit)
	attachStreams(cmd, spec, stdout, stderr)
	if err := cmd.Start(); err != nil {
		return ProcessResult{RC: 126}, err
	}
	process, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(cmd.Process.Pid),
	)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return ProcessResult{RC: 78}, err
	}
	defer windows.CloseHandle(process)

	if err := startProcessJob(ctx, job, process, cmd.Process.Pid, spec.RecordOwner); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return ProcessResult{RC: 78}, err
	}
	runErr := waitProcessHandle(ctx, process)
	closeErr := closeProcessJob(job)
	if closeErr != nil {
		// Не оставляем kill-on-close до завершения Wait, которое само ждёт лидера.
		windows.CloseHandle(job)
		job = 0
		_ = cmd.Process.Kill()
		return ProcessResult{RC: 75}, errors.Join(closeErr, waitCommand(cmd))
	}
	waitErr := cmd.Wait()
	result := ProcessResult{
		Stdout: stdout.buffer.Bytes(), Stderr: stderr.buffer.Bytes(), OutputOverflow: stdout.overflow,
		OwnedTreeClosed: true,
	}
	if errors.Is(runErr, context.DeadlineExceeded) {
		result.RC = 124
	} else if errors.Is(runErr, context.Canceled) {
		result.RC = 130
	} else if waitErr != nil || runErr != nil {
		result.RC = 1
		var exit *exec.ExitError
		if errors.As(waitErr, &exit) && exit.ExitCode() >= 0 {
			result.RC = exit.ExitCode()
		}
	}

	return result, errors.Join(runErr, waitErr)
}

// waitCommand ограничивает ожидание при уже неподтверждённом закрытии Job.
// Буферы команды на этом пути не возвращаются вызывающему.
func waitCommand(cmd *exec.Cmd) error {
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(2 * time.Second):
		return ErrUnconfirmedTree
	}
}

// newProcessJob не передаёт handle потомкам.
// При аварийном выходе фабрики ядро завершает всех участников Job.
func newProcessJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}

	return job, nil
}

// startProcessJob разрешает выполнение только после привязки к Job и публикации владельца.
// Любая ошибка до ResumeThread оставляет дочерний процесс приостановленным.
func startProcessJob(ctx context.Context, job, process windows.Handle, pid int, record func(TreeOwner) error) error {
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		return err
	}
	leader, err := windowsIdentity(pid)
	if err != nil {
		return err
	}
	if record != nil {
		if err := record(TreeOwner{Leader: leader}); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	thread, err := suspendedThread(uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(thread)

	if previous, err := windows.ResumeThread(thread); err != nil || previous != 1 {
		return fmt.Errorf("%w: результат ResumeThread %d: %v", ErrUnconfirmedTree, previous, err)
	}

	return nil
}

// suspendedThread находит единственный поток созданного в suspended-состоянии процесса.
// Owner повторно проверяется на открытом handle, чтобы исключить повторное использование TID.
func suspendedThread(pid uint32) (windows.Handle, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(snapshot)

	var id uint32
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	for err := windows.Thread32First(snapshot, &entry); ; err = windows.Thread32Next(snapshot, &entry) {
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			break
		}
		if err != nil {
			return 0, err
		}
		if entry.OwnerProcessID != pid {
			continue
		}
		if id != 0 {
			return 0, ErrUnconfirmedTree
		}
		id = entry.ThreadID
	}
	if id == 0 {
		return 0, ErrUnconfirmedTree
	}
	thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME|windows.THREAD_QUERY_LIMITED_INFORMATION,
		false, id)
	if err != nil {
		return 0, err
	}
	owner, _, _ := getProcessIDOfThread.Call(uintptr(thread))
	if owner != uintptr(pid) {
		windows.CloseHandle(thread)
		return 0, ErrUnconfirmedTree
	}

	return thread, nil
}

// waitProcessHandle ждёт лидера независимо от stdout потомков.
// При отмене Job очищается до ожидания копировщиков exec.Cmd.
func waitProcessHandle(ctx context.Context, process windows.Handle) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		state, err := windows.WaitForSingleObject(process, 25)
		if err != nil || state == windows.WAIT_OBJECT_0 {
			return err
		}
		if state != uint32(windows.WAIT_TIMEOUT) {
			return ErrUnconfirmedTree
		}
	}
}

// closeProcessJob доставляет остановку всем оставшимся участникам.
// Пустой Job должен подтвердить сам Windows до возврата успешного результата.
func closeProcessJob(job windows.Handle) error {
	deadline := time.Now().Add(4 * time.Second)
	stopping := false
	for {
		var counts jobAccounting
		err := windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation,
			uintptr(unsafe.Pointer(&counts)), uint32(unsafe.Sizeof(counts)), nil)
		if err != nil {
			return err
		}
		if counts.ActiveProcesses == 0 {
			return nil
		}
		if !stopping {
			if err := windows.TerminateJobObject(job, 130); err != nil {
				return err
			}
			stopping = true
		}
		if time.Now().After(deadline) {
			return ErrUnconfirmedTree
		}
		time.Sleep(20 * time.Millisecond)
	}
}
