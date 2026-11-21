package host

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"time"
)

type Process struct {
	Path         string
	Args         []string
	Dir          string
	Env          []string
	Files        []*os.File
	Timeout      time.Duration
	Limit        int
	Owned        bool
	RecordOwner  func(TreeOwner) error
	BeforePermit func(*ProcessLaunch) error
	Stdin        io.Reader
	StdoutSink   io.Writer
	StderrSink   io.Writer
}

type ProcessLaunch struct {
	Args []string
	Env  []string
}

type ProcessResult struct {
	Stdout          []byte
	Stderr          []byte
	RC              int
	OutputOverflow  bool
	OwnedTreeClosed bool
	Err             error
}

// RunProcess исполняет argv с заданным окружением и дескрипторами.
// WaitDelay ограничивает ожидание копировщиков при унаследованном потомком канале.
func RunProcess(parent context.Context, spec Process) ProcessResult {
	ctx := parent
	if spec.Timeout > 0 {
		bounded, cancel := context.WithTimeout(parent, spec.Timeout)
		defer cancel()
		ctx = bounded
	}
	if spec.Owned {
		result, err := runOwnedProcess(ctx, spec)
		result.Err = err
		return result
	}
	if spec.BeforePermit != nil {
		return ProcessResult{RC: 78, Err: errors.New("для настройки запуска нужен подтверждённый owner")}
	}
	cmd := exec.CommandContext(ctx, spec.Path, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = append([]string{}, spec.Env...)
	cmd.ExtraFiles = spec.Files
	cmd.WaitDelay = 500 * time.Millisecond
	stdout, stderr := newProcessOutput(spec.Limit), newProcessOutput(spec.Limit)
	attachStreams(cmd, spec, stdout, stderr)
	err := cmd.Run()
	result := ProcessResult{
		Stdout: stdout.buffer.Bytes(), Stderr: stderr.buffer.Bytes(), OutputOverflow: stdout.overflow,
		Err: err,
	}
	if err == nil {
		return result
	}
	result.RC = 1
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() >= 0 {
		result.RC = exit.ExitCode()
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		result.RC, result.Err = 124, ctx.Err()
	} else if errors.Is(ctx.Err(), context.Canceled) {
		result.RC, result.Err = 130, ctx.Err()
	}
	return result
}

// attachStreams ведёт ограниченную копию диагностики и сохраняет штатные потоки запуска.
func attachStreams(cmd *exec.Cmd, spec Process, stdout, stderr io.Writer) {
	cmd.Stdin = spec.Stdin
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if spec.StdoutSink != nil {
		cmd.Stdout = io.MultiWriter(spec.StdoutSink, stdout)
	}
	if spec.StderrSink != nil {
		cmd.Stderr = io.MultiWriter(spec.StderrSink, stderr)
	}
}

type processOutput struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func newProcessOutput(limit int) *processOutput {
	if limit <= 0 {
		limit = 64 * 1024
	}
	return &processOutput{limit: limit}
}

// Write ограничивает буфер и продолжает дренировать поток до выхода.
// Усечённый stdout отмечается отдельно, чтобы его нельзя было принять как полный DTO.
func (o *processOutput) Write(data []byte) (int, error) {
	remaining := o.limit - o.buffer.Len()
	if len(data) > remaining {
		o.overflow = true
		_, _ = o.buffer.Write(data[:remaining])
	} else {
		_, _ = o.buffer.Write(data)
	}
	return len(data), nil
}
