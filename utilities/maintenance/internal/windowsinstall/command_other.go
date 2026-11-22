//go:build !windows

package windowsinstall

import (
	"os"
	"os/exec"
)

func setInstallerCommandLine(_ *exec.Cmd, _, _ string) {}

func reserveInstallation() (func(), error) { return nil, os.ErrInvalid }

func undoDesktopInstall(_ string) error { return nil }
