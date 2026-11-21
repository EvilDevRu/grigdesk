package update

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/internal/installation"
	"grigdesk.local/tools/utilities/internal/processidentity"
)

func validOwner(ctx context.Context, root, relative string, owner Process) bool {
	actual, code := processidentity.InspectDarwin(ctx, owner.PID)
	return code == 0 && actual.Starttime == owner.Starttime && actual.Executable == owner.Executable &&
		strings.HasPrefix(actual.Executable, filepath.Join(root, relative)+"/")
}

func previousOwnersStopped(ctx context.Context, layout *installation.Layout, job *Job, saved *Handoff) error {
	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	pids, err := processidentity.DarwinUIDPIDs()
	if err != nil {
		return err
	}
	for _, pid := range pids {
		owner, code := processidentity.InspectDarwin(deadline, pid)
		if code == 3 {
			continue
		}
		if code != 0 || deadline.Err() != nil {
			return errors.New("release_process_owner_invalid")
		}
		for _, part := range []string{"desktop", "server"} {
			relative := component(job.Previous, part)
			if relative == nil || part == "desktop" && job.Scope == "server" ||
				part == "server" && !saved.StopLocal {
				continue
			}
			if strings.HasPrefix(owner.Executable, filepath.Join(layout.Receipt.Root, *relative)+"/") {
				return errReleaseOwnerActive
			}
		}
	}
	return nil
}

func observeProcess(ctx context.Context, pid int) (Process, error) {
	actual, code := processidentity.InspectDarwin(ctx, pid)
	if code != 0 {
		return Process{}, errors.New("release_process_owner_invalid")
	}
	return Process{PID: pid, Starttime: actual.Starttime, Executable: actual.Executable}, nil
}

func processParent(pid int) int {
	actual, code := processidentity.InspectDarwin(context.Background(), pid)
	if code != 0 {
		return 0
	}
	return actual.PPID
}

func stopManualProcess(context.Context, Process) error {
	return errors.New("release_server_native_stop_required")
}
