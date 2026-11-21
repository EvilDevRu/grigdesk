//go:build unix

package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const permitCommand = "_factory-permit-exec"
const permitLimit = 4 * 1024 * 1024

// PermitChild выполняется только дочерним wrapper с отдельным pipe.
// По EOF, timeout или неверному дескриптору исходная команда не запускается.
func PermitChild(args []string) (bool, int) {
	if len(args) == 0 || args[0] != permitCommand {
		return false, 0
	}
	if len(args) < 3 || !strings.HasPrefix(args[2], "/") {
		return true, 126
	}
	fd, err := strconv.Atoi(args[1])
	if err != nil || fd < 3 {
		return true, 126
	}
	channel := os.NewFile(uintptr(fd), "launch permit")
	if channel == nil {
		return true, 126
	}
	info, err := channel.Stat()
	if err != nil || info.Mode()&os.ModeNamedPipe == 0 {
		channel.Close()
		return true, 126
	}
	result := make(chan []byte, 1)
	go func() {
		value, err := io.ReadAll(io.LimitReader(channel, permitLimit+1))
		if err != nil || len(value) > permitLimit {
			value = nil
		}
		result <- value
	}()
	launch := ProcessLaunch{Args: args[3:], Env: os.Environ()}
	select {
	case packet := <-result:
		_ = channel.Close()
		if len(packet) == 0 || packet[0] != 1 ||
			(len(packet) > 1 && json.Unmarshal(packet[1:], &launch) != nil) {
			return true, 126
		}
	case <-time.After(10 * time.Second):
		_ = channel.Close()
		return true, 124
	}
	signal.Reset(syscall.SIGTERM, syscall.SIGINT)
	if err := syscall.Exec(args[2], append([]string{args[2]}, launch.Args...), launch.Env); err != nil {
		return true, 126
	}
	return true, 0
}

// runOwnedProcess создаёт сессию до запуска эффекта и фиксирует owner перед permit.
// Закрытие потоков проверяется отдельно от Process.Wait.
func runOwnedProcess(ctx context.Context, spec Process) (ProcessResult, error) {
	if err := ctx.Err(); err != nil {
		return ProcessResult{RC: 130}, err
	}
	executable, err := os.Executable()
	if err != nil {
		return ProcessResult{RC: 78}, err
	}
	target, err := exec.LookPath(spec.Path)
	if err != nil {
		return ProcessResult{RC: 126}, err
	}
	read, permit, err := os.Pipe()
	if err != nil {
		return ProcessResult{RC: 78}, err
	}
	defer read.Close()
	defer permit.Close()
	fd := strconv.Itoa(3 + len(spec.Files))
	args := append([]string{permitCommand, fd, target}, spec.Args...)
	cmd := exec.Command(executable, args...)
	cmd.Dir = spec.Dir
	cmd.Env = append([]string{}, spec.Env...)
	cmd.ExtraFiles = append(append([]*os.File{}, spec.Files...), read)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.WaitDelay = 500 * time.Millisecond
	stdout, stderr := newProcessOutput(spec.Limit), newProcessOutput(spec.Limit)
	attachStreams(cmd, spec, stdout, stderr)
	if err := cmd.Start(); err != nil {
		return ProcessResult{RC: 126}, err
	}
	_ = read.Close()
	owner, err := CaptureTree(cmd.Process.Pid)
	if err == nil && owner.Leader.PPID != os.Getpid() {
		err = ErrUnconfirmedTree
	}
	if err == nil && spec.RecordOwner != nil {
		err = spec.RecordOwner(owner)
	}
	packet := []byte{1}
	if err == nil && spec.BeforePermit != nil {
		packet, err = preparePermit(spec)
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		_, err = permit.Write(packet)
	}
	_ = permit.Close()
	if err != nil {
		return ProcessResult{RC: 78}, errors.Join(err, cmd.Wait())
	}
	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	tree, waitErr, closed := awaitOwned(ctx, cmd.Process.Pid, owner, wait)
	if !closed {
		return ProcessResult{RC: 75}, tree
	}
	result := ProcessResult{
		Stdout: stdout.buffer.Bytes(), Stderr: stderr.buffer.Bytes(), OutputOverflow: stdout.overflow,
	}
	if tree != nil {
		result.RC = 75
		return result, tree
	}
	result.OwnedTreeClosed = true
	if waitErr == nil {
		return result, nil
	}
	result.RC = 1
	var exit *exec.ExitError
	if errors.As(waitErr, &exit) && exit.ExitCode() >= 0 {
		result.RC = exit.ExitCode()
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		result.RC = 124
	} else if errors.Is(ctx.Err(), context.Canceled) {
		result.RC = 130
	}
	return result, waitErr
}

// preparePermit соединяет запуск с допуском после проверки владельца.
// Дочерний процесс получает значения только через приватный pipe и ждёт EOF.
func preparePermit(spec Process) ([]byte, error) {
	launch := ProcessLaunch{Args: spec.Args, Env: spec.Env}
	if err := spec.BeforePermit(&launch); err != nil {
		return nil, err
	}
	wire, err := json.Marshal(launch)
	if err != nil || len(wire) >= permitLimit {
		return nil, fmt.Errorf("не удалось передать конфигурацию дочернего процесса")
	}
	return append([]byte{1}, wire...), nil
}

// awaitOwned проверяет сессию даже после раннего выхода лидера.
// При отмене ожидание исторического wait не задерживает TERM участникам.
func awaitOwned(
	ctx context.Context, pid int, owner TreeOwner, wait <-chan error,
) (treeErr, waitErr error, streamsClosed bool) {
	ticker := time.NewTicker(30 * time.Millisecond)
	defer ticker.Stop()
	reaped := false
selectLoop:
	for {
		select {
		case waitErr = <-wait:
			reaped = true
			break selectLoop
		case <-ctx.Done():
			break selectLoop
		case <-ticker.C:
			current, err := owner.identify()
			if err == nil && len(current) > 0 {
				owner.Members = current
			}
			leader, err := readIdentity(pid, owner.Leader.Boot)
			if errors.Is(err, errNoProcess) || (err == nil && leader.State == "Z") {
				break selectLoop
			}
		}
	}
	cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	treeErr = StopTree(cleanup, owner, 250*time.Millisecond)
	if !reaped {
		select {
		case waitErr = <-wait:
		case <-cleanup.Done():
			// WaitDelay завершает копировщиков после выхода лидера.
			// До подтверждённого выхода stdout/stderr нельзя читать конкурентно.
			return fmt.Errorf("%w: wait не завершён", ErrUnconfirmedTree), nil, false
		}
	}
	return treeErr, waitErr, true
}
