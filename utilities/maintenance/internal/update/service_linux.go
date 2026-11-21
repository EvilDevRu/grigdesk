package update

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/internal/installation"
)

const unitName = "grigdesk-server.service"

func platformUnit(ctx context.Context, layout *installation.Layout) (bool, error) {
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	probe := exec.CommandContext(bounded, "/usr/bin/systemctl", "--user", "show", unitName,
		"--property=LoadState,WorkingDirectory,FragmentPath,ExecStart")
	content, err := probe.Output()
	if err != nil {
		return false, nil
	}
	fields := make(map[string]string)
	for _, line := range strings.Split(string(content), "\n") {
		if key, value, ok := strings.Cut(line, "="); ok {
			fields[key] = value
		}
	}
	if fields["LoadState"] == "not-found" {
		return false, nil
	}
	root := layout.Receipt.Root
	launcher := filepath.Join(root, "bin", "grigdesk-server")
	fragment := fields["FragmentPath"]
	if fields["LoadState"] != "loaded" || fields["WorkingDirectory"] != root ||
		!strings.Contains(fields["ExecStart"], "path="+launcher+" ;") ||
		!filepath.IsAbs(fragment) || filepath.Base(fragment) != unitName {
		return false, errors.New("release_foreign_service")
	}
	proof, err := installation.ProveFile(fragment)
	if err != nil || proof.Mode != 0o600 {
		return false, errors.New("release_foreign_service")
	}
	bytes, err := installation.ReadOrdinary(fragment, 64<<10)
	if err != nil || !strings.HasPrefix(string(bytes), "# GrigDesk installationId="+layout.Receipt.InstallationID+"\n") {
		return false, errors.New("release_foreign_service")
	}
	return true, nil
}

func startPlatformService(ctx context.Context, layout *installation.Layout) (bool, error) {
	unit, err := platformUnit(ctx, layout)
	if err != nil || !unit {
		return false, err
	}
	return true, controlPlatformService(ctx, "start", "--no-block", unitName)
}

func stopPlatformService(ctx context.Context, layout *installation.Layout) error {
	unit, err := platformUnit(ctx, layout)
	if err != nil || !unit {
		return errors.New("release_foreign_service")
	}
	return controlPlatformService(ctx, "stop", unitName)
}

func serverJournal(ctx context.Context, layout *installation.Layout, lines string, follow bool) (*exec.Cmd, error) {
	unit, err := platformUnit(ctx, layout)
	if err != nil || !unit {
		return nil, err
	}
	args := []string{"--user", "-u", unitName, "-n", lines, "--no-pager"}
	if follow {
		args = append(args, "-f")
	}
	return exec.CommandContext(ctx, "/usr/bin/journalctl", args...), nil
}

func controlPlatformService(ctx context.Context, args ...string) error {
	bounded, cancel := context.WithTimeout(ctx, 65*time.Second)
	defer cancel()
	command := exec.CommandContext(bounded, "/usr/bin/systemctl", append([]string{"--user"}, args...)...)
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return errors.New("release_service_command_failed")
	}
	return nil
}
