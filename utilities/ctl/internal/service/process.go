package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	ctlterm "grigdesk.local/tools/utilities/ctl/internal/terminal"
)

type Terminal struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	Screen *ctlterm.Screen
}

type Result struct {
	Stdout  string
	Stderr  string
	Code    int
	Missing bool
}

// Query ограничивает срок системного чтения и хранит потоки раздельно.
func Query(ctx context.Context, timeout time.Duration, name string, argv ...string) Result {
	bounded, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(bounded, name, argv...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	return Result{
		Stdout: stdout.String(), Stderr: stderr.String(), Code: ExitCode(err),
		Missing: errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist),
	}
}

func (term Terminal) Attached(ctx context.Context, name string, argv ...string) int {
	command := exec.CommandContext(ctx, name, argv...)
	command.Stdin, command.Stdout, command.Stderr = term.Stdin, term.Stdout, term.Stderr
	err := command.Run()
	if err != nil && ExitCode(err) == 1 {
		var status *exec.ExitError
		if !errors.As(err, &status) {
			_, _ = fmt.Fprintln(term.Stderr, Printable(err.Error()))
		}
	}
	return ExitCode(err)
}

func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	var status *exec.ExitError
	if !errors.As(err, &status) {
		return 1
	}
	if value, ok := status.Sys().(syscall.WaitStatus); ok && value.Signaled() {
		return 128 + int(value.Signal())
	}
	return status.ExitCode()
}

// Printable оставляет в статусе только безопасные для терминала символы.
func Printable(text string) string {
	return strings.Map(func(r rune) rune {
		if r < 32 || r >= 127 && r <= 159 {
			return '?'
		}
		return r
	}, text)
}

func (term Terminal) Say(text string) int {
	_, _ = fmt.Fprintln(term.Stdout, text)
	return 0
}

func (term Terminal) Fail(text string, code int) int {
	_, _ = fmt.Fprintln(term.Stderr, Printable(text))
	return code
}
