package supervisor

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const greeting = "grigdesk-relay-worker\n"
const pulse = "heartbeat\n"

// Run запускает рабочую часть из того же физического исполняемого файла.
// Сторож владеет ровно одним дочерним процессом и своим концом закрытого IPC.
func Run(ctx context.Context, executable string, stdout, stderr io.Writer, timeout time.Duration) int {
	parent, inherited, err := pair()
	if err != nil {
		return 1
	}
	defer parent.Close()
	command := exec.Command(executable, "--worker")
	command.Stdout = stdout
	command.Stderr = stderr
	command.ExtraFiles = []*os.File{inherited}
	if err := command.Start(); err != nil {
		inherited.Close()
		return 1
	}
	inherited.Close()
	closed := make(chan error, 1)
	go func() { closed <- command.Wait() }()
	if _, err := io.WriteString(parent, greeting); err != nil {
		stop(command.Process, closed, 2*time.Second)
		return 1
	}
	heartbeats := make(chan time.Time, 1)
	eof := make(chan struct{})
	go readHeartbeats(parent, heartbeats, eof)
	return supervise(ctx, command.Process, closed, heartbeats, eof, timeout)
}

// readHeartbeats различает правильный heartbeat и завершение приватного канала.
// Канал ограничен одним последним наблюдением, медленный сторож не копит кадры.
func readHeartbeats(conn net.Conn, output chan<- time.Time, eof chan<- struct{}) {
	defer close(eof)
	received := bufio.NewReaderSize(conn, 64)
	for {
		line, err := received.ReadSlice('\n')
		if err != nil || string(line) != pulse {
			return
		}
		select {
		case output <- time.Now():
		default:
		}
	}
}

// supervise обрабатывает независимый монотонный срок, EOF IPC и выход ребёнка.
// Нормальная остановка по сигналу сохраняет код 0 даже при принудительной очистке.
func supervise(
	ctx context.Context, process *os.Process, closed <-chan error,
	heartbeats <-chan time.Time, eof <-chan struct{}, duration time.Duration,
) int {
	lastSeen := time.Now()
	timer := time.NewTicker(min(time.Second, max(20*time.Millisecond, duration/3)))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			stop(process, closed, 4500*time.Millisecond)
			return 0
		case <-closed:
			if ctx.Err() != nil {
				return 0
			}
			return 1
		case <-eof:
			if ctx.Err() != nil {
				stop(process, closed, 4500*time.Millisecond)
				return 0
			}
			stop(process, closed, 2*time.Second)
			return 1
		case lastSeen = <-heartbeats:
		case now := <-timer.C:
			if now.Sub(lastSeen) > duration {
				stop(process, closed, 2*time.Second)
				return 1
			}
		}
	}
}

// pair выдаёт неназванный Unix-сокет, не оставляя доступного извне файла.
// Child получает только свою сторону по ExtraFiles, остальные дескрипторы закрыты при exec.
func pair() (net.Conn, *os.File, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, nil, err
	}
	for _, fd := range fds {
		syscall.CloseOnExec(fd)
	}
	parent := os.NewFile(uintptr(fds[0]), "relay-parent")
	defer parent.Close()
	child := os.NewFile(uintptr(fds[1]), "relay-worker")
	conn, err := net.FileConn(parent)
	if err != nil {
		child.Close()
		return nil, nil, err
	}
	return conn, child, nil
}

// Worker принимает унаследованный закрытый IPC и подтверждение от сторожа.
// При потере владельца контекст рабочей части отменяется до закрытия listener.
func Worker(parent context.Context) (context.Context, *Channel, error) {
	file := os.NewFile(3, "relay-worker")
	if file == nil {
		return nil, nil, errors.New("Канал сторожа не открыт")
	}
	defer file.Close()
	conn, err := net.FileConn(file)
	if err != nil {
		return nil, nil, err
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	reader := bufio.NewReaderSize(conn, 64)
	line, err := reader.ReadSlice('\n')
	if err != nil || string(line) != greeting || conn.LocalAddr().Network() != "unix" {
		conn.Close()
		return nil, nil, errors.New("Канал сторожа не подтверждён")
	}
	_ = conn.SetReadDeadline(time.Time{})
	ctx, cancel := context.WithCancel(parent)
	go func() {
		_, _ = io.Copy(io.Discard, reader)
		cancel()
	}()
	return ctx, &Channel{conn: conn, cancel: cancel}, nil
}

type Channel struct {
	conn   net.Conn
	cancel context.CancelFunc
}

func (channel *Channel) Close() {
	channel.cancel()
	_ = channel.conn.Close()
}

// Heartbeat сообщает о готовности сразу, далее подтверждает жизнь каждую секунду.
// Закрытый канал отменяет рабочий процесс отдельно от срока сторожа.
func (channel *Channel) Heartbeat(ctx context.Context) {
	clock := time.NewTicker(time.Second)
	defer clock.Stop()
	for ctx.Err() == nil {
		_ = channel.conn.SetWriteDeadline(time.Now().Add(time.Second))
		if _, err := io.WriteString(channel.conn, pulse); err != nil {
			channel.cancel()
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-clock.C:
		}
	}
}

// stop сигналит только объекту дочернего процесса этого сторожа.
// При истечении срока принудительно завершает дочерний процесс и забирает статус.
func stop(process *os.Process, closed <-chan error, limit time.Duration) {
	_ = process.Signal(syscall.SIGTERM)
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case <-closed:
	case <-timer.C:
		_ = process.Kill()
		<-closed
	}
}
