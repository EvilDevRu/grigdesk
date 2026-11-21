package install

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/internal/processidentity"
)

func censusLegacy(ctx context.Context, root string, state cutoverIntent) error {
	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	pids, err := processidentity.DarwinUIDPIDs()
	if err != nil {
		return err
	}
	for _, pid := range pids {
		if pid == os.Getpid() {
			continue
		}
		found, status := processidentity.InspectDarwin(deadline, pid)
		if status == 3 {
			continue
		}
		if status != 0 || deadline.Err() != nil {
			return errors.New("release_cutover_process_identity_unavailable")
		}
		if found.Executable == filepath.Join(root, "update", "maintenance") {
			return errors.New("release_go_migration_owner_active")
		}
		for _, old := range state.Legacy {
			if strings.HasPrefix(found.Executable, filepath.Join(root, "generations", old.Version)+"/") ||
				strings.HasPrefix(found.Executable,
					filepath.Join(root, "update", "go-cutover", state.TargetVersion, old.Version)+"/") {
				return errors.New("release_go_migration_owner_active")
			}
		}
	}
	return nil
}
