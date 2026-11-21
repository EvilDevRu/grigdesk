package state

import (
	"errors"
	"io"
	"os/exec"
	"path/filepath"
)

// bindPublishedAttempt зовёт helper после проверки неизменяемого каталога под task lock.
// Только нулевой исход разрешает вызывающему опубликовать активный указатель.
func bindPublishedAttempt(node, helper, reservation, task, attempt, dir string, log io.Writer) int {
	if node == "" && helper == "" && reservation == "" {
		return 0
	}
	if !filepath.IsAbs(node) || !filepath.IsAbs(helper) || !filepath.IsAbs(reservation) {
		return 78
	}
	cmd := exec.Command(node, helper, "bind", "--reservation", reservation,
		"--task", task, "--attempt", attempt, "--attempt-dir", dir)
	cmd.Stderr = log
	if err := cmd.Run(); err != nil {
		var failure *exec.ExitError
		if errors.As(err, &failure) && failure.ExitCode() > 0 {
			return failure.ExitCode()
		}
		return 1
	}
	return 0
}
