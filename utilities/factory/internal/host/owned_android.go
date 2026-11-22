package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const androidSupervisor = "_factory-android-supervisor"
const androidPermitLimit = 4 * 1024 * 1024
const androidCleanupTimeout = 3 * time.Second

// runOwnedProcess запускает отдельный subreaper и сохраняет личность до передачи допуска.
// Супервизор получает EOF при остановке либо аварийном выходе координатора.
func runOwnedProcess(ctx context.Context, spec Process) (ProcessResult, error) {
	if err := ctx.Err(); err != nil {
		return ProcessResult{RC: 130}, err
	}
	target, err := exec.LookPath(spec.Path)
	if err != nil {
		return ProcessResult{RC: 126}, err
	}
	executable, err := os.Executable()
	if err != nil {
		return ProcessResult{RC: 78}, err
	}
	control, permit, err := os.Pipe()
	if err != nil {
		return ProcessResult{RC: 78}, err
	}
	defer control.Close()
	defer permit.Close()

	proof, confirmed, err := os.Pipe()
	if err != nil {
		return ProcessResult{RC: 78}, err
	}
	defer proof.Close()
	defer confirmed.Close()

	controlFD := 3 + len(spec.Files)
	cmd := exec.Command(executable, androidSupervisor, strconv.Itoa(controlFD), target)
	cmd.Dir = spec.Dir
	cmd.Env = append([]string{}, spec.Env...)
	cmd.ExtraFiles = append(append([]*os.File{}, spec.Files...), control, confirmed)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.WaitDelay = 500 * time.Millisecond

	stdout, stderr := newProcessOutput(spec.Limit), newProcessOutput(spec.Limit)
	attachStreams(cmd, spec, stdout, stderr)
	if err := cmd.Start(); err != nil {
		return ProcessResult{RC: 126}, err
	}
	control.Close()
	confirmed.Close()

	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	if err := permitAndroidProcess(ctx, cmd.Process.Pid, spec, permit); err != nil {
		permit.Close()
		if ctx.Err() != nil {
			return ProcessResult{RC: androidContextCode(ctx)}, errors.Join(err, waitAndroidProcess(cmd, wait))
		}
		return ProcessResult{RC: 78}, errors.Join(err, waitAndroidProcess(cmd, wait))
	}

	var waitErr error
	select {
	case waitErr = <-wait:
	case <-ctx.Done():
		permit.Close()
		waitErr = waitAndroidProcess(cmd, wait)
	}
	ack, err := io.ReadAll(io.LimitReader(proof, 2))
	if err != nil || len(ack) != 1 || ack[0] != 1 {
		return ProcessResult{RC: 75}, errors.Join(ErrUnconfirmedTree, waitErr, err,
			errors.New(stderr.buffer.String()))
	}

	result := ProcessResult{Stdout: stdout.buffer.Bytes(), Stderr: stderr.buffer.Bytes(),
		OutputOverflow: stdout.overflow, OwnedTreeClosed: true}
	if ctx.Err() != nil {
		result.RC = androidContextCode(ctx)
		return result, ctx.Err()
	}
	if waitErr != nil {
		result.RC = 1
		var exited *exec.ExitError
		if errors.As(waitErr, &exited) && exited.ExitCode() >= 0 {
			result.RC = exited.ExitCode()
		}
	}
	return result, waitErr
}

// permitAndroidProcess пропускает запуск только после проверки pid, родителя и сессии.
// Изменения argv и окружения передаются по унаследованной трубе.
func permitAndroidProcess(ctx context.Context, pid int, spec Process, permit *os.File) error {
	self, err := CurrentIdentity()
	if err != nil {
		return err
	}
	owner, err := readIdentity(pid, self.Boot)
	if err != nil || owner.PPID != self.PID || owner.UID != self.UID ||
		owner.PID != owner.Session || owner.PID != owner.Group {
		return errors.Join(ErrUnconfirmedTree, err)
	}
	if spec.RecordOwner != nil {
		if err := spec.RecordOwner(TreeOwner{Leader: owner}); err != nil {
			return err
		}
	}
	launch := ProcessLaunch{Args: spec.Args, Env: append([]string{}, spec.Env...)}
	if spec.BeforePermit != nil {
		if err := spec.BeforePermit(&launch); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	packet, err := json.Marshal(launch)
	if err != nil {
		return err
	}
	if len(packet) >= androidPermitLimit {
		return errors.New("допуск Android превышает лимит")
	}
	_, err = permit.Write(append(packet, '\n'))
	return err
}

// waitAndroidProcess даёт супервизору время закрыть потомков после EOF.
// Его аварийная остановка сама по себе не считается доказательством завершения.
func waitAndroidProcess(cmd *exec.Cmd, wait <-chan error) error {
	select {
	case err := <-wait:
		return err
	case <-time.After(androidCleanupTimeout + time.Second):
		_ = cmd.Process.Kill()
		return errors.Join(ErrUnconfirmedTree, <-wait)
	}
}

func androidContextCode(ctx context.Context) int {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return 124
	}
	return 130
}

// PermitChild включает subreaper до запуска команды и отвечает доказательством после wait4(ECHILD).
// Созданная сессия принадлежит одному супервизору и не затрагивает процессы других приложений.
func PermitChild(args []string) (bool, int) {
	if len(args) == 0 || args[0] != androidSupervisor {
		return false, 0
	}
	if len(args) != 3 || !filepath.IsAbs(args[2]) {
		return true, 126
	}
	fd, err := strconv.Atoi(args[1])
	if err != nil || fd < 3 || fd > 1024 {
		return true, 126
	}
	if err := runAndroidSupervisor(fd, args[2]); err != nil {
		var exited androidExit
		if errors.As(err, &exited) {
			return true, int(exited)
		}
		fmt.Fprintf(os.Stderr, "Android supervisor: %v\n", err)
		return true, 75
	}
	return true, 0
}

type androidExit int

func (e androidExit) Error() string { return strconv.Itoa(int(e)) }

// runAndroidSupervisor владеет дочерними процессами до подтверждённого закрытия.
// Дескрипторы допуска и ответа остаются у наблюдателя, дочерняя программа их не наследует.
func runAndroidSupervisor(fd int, target string) error {
	control := os.NewFile(uintptr(fd), "android permit")
	proof := os.NewFile(uintptr(fd+1), "android completion")
	defer control.Close()
	defer proof.Close()
	unix.CloseOnExec(fd)
	unix.CloseOnExec(fd + 1)
	for _, pipe := range []*os.File{control, proof} {
		info, err := pipe.Stat()
		if err != nil || info.Mode()&os.ModeNamedPipe == 0 {
			return errors.New("отсутствует унаследованный парный канал")
		}
	}
	if err := unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0); err != nil {
		return err
	}
	var launch ProcessLaunch
	if err := json.NewDecoder(io.LimitReader(control, androidPermitLimit)).Decode(&launch); err != nil {
		return err
	}
	stop := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, control)
		close(stop)
	}()
	files := []*os.File{os.Stdin, os.Stdout, os.Stderr}
	for i := 3; i < fd; i++ {
		files = append(files, os.NewFile(uintptr(i), "android inherited fd"))
	}
	process, err := os.StartProcess(target, append([]string{target}, launch.Args...),
		&os.ProcAttr{Env: launch.Env, Files: files})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if _, err := proof.Write([]byte{1}); err != nil {
			return err
		}
		return androidExit(126)
	}
	defer process.Release()
	rc, err := reapAndroidChildren(process.Pid, stop)
	if err != nil {
		return err
	}
	if _, err := proof.Write([]byte{1}); err != nil {
		return err
	}
	if rc != 0 {
		return androidExit(rc)
	}
	return nil
}

// reapAndroidChildren ждёт возвращения ECHILD от ядра, включая усыновлённых потомков.
// Наличие живого либо невидимого в proc потомка оставляет результат неподтверждённым.
func reapAndroidChildren(leader int, stop <-chan struct{}) (int, error) {
	var killAt time.Time
	rc := 75
	for {
		var status unix.WaitStatus
		pid, err := unix.Wait4(-1, &status, unix.WNOHANG, nil)
		switch {
		case errors.Is(err, unix.ECHILD):
			return rc, nil
		case errors.Is(err, unix.EINTR):
			continue
		case err != nil:
			return 75, err
		case pid == leader:
			rc = status.ExitStatus()
			if status.Signaled() {
				rc = 128 + int(status.Signal())
			}
			if killAt.IsZero() {
				killAt = time.Now().Add(250 * time.Millisecond)
			}
			continue
		case pid > 0:
			continue
		}
		select {
		case <-stop:
			stop = nil
			if killAt.IsZero() {
				killAt = time.Now().Add(250 * time.Millisecond)
			}
		default:
		}
		if !killAt.IsZero() {
			if time.Now().After(killAt.Add(androidCleanupTimeout - 250*time.Millisecond)) {
				return 75, ErrUnconfirmedTree
			}
			sig := unix.SIGTERM
			if !time.Now().Before(killAt) {
				sig = unix.SIGKILL
			}
			if err := signalAndroidChildren(sig); err != nil {
				return 75, err
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// signalAndroidChildren использует только номера, читая минимум из proc.
// Перед сигналом waitid подтверждает дочернюю связь по тому же pidfd.
func signalAndroidChildren(sig unix.Signal) error {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || !entry.IsDir() {
			continue
		}
		if err := signalAndroidChild(pid, sig); err != nil {
			return err
		}
	}
	return nil
}

// signalAndroidChild никогда не адресует сигнал по числовому PID.
// waitid отфильтровывает процессы, не принадлежащие супервизору.
func signalAndroidChild(pid int, sig unix.Signal) error {
	fd, err := unix.PidfdOpen(pid, 0)
	if errors.Is(err, unix.ESRCH) {
		return nil
	}
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	err = unix.Waitid(unix.P_PIDFD, fd, nil, unix.WEXITED|unix.WNOHANG|unix.WNOWAIT, nil)
	if errors.Is(err, unix.ECHILD) || errors.Is(err, unix.ESRCH) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = unix.PidfdSendSignal(fd, sig, nil, 0); err != nil && !errors.Is(err, unix.ESRCH) {
		return err
	}
	if sig == unix.SIGTERM {
		err = unix.PidfdSendSignal(fd, unix.SIGCONT, nil, 0)
		if err != nil && !errors.Is(err, unix.ESRCH) {
			return err
		}
	}
	return nil
}
