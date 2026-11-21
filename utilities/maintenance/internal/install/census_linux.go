package install

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/internal/processidentity"
)

func censusLegacy(ctx context.Context, root string, state cutoverIntent) error {
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tasks, err := os.ReadDir("/proc")
	if err != nil || len(tasks) > 1<<16 {
		return errors.New("release_cutover_process_identity_unavailable")
	}
	for _, task := range tasks {
		if err := deadline.Err(); err != nil {
			return errors.New("release_cutover_process_identity_unavailable")
		}
		pid, err := strconv.Atoi(task.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		if err := proveLegacyProcess(root, state, pid); err != nil {
			return err
		}
	}
	return nil
}

func proveLegacyProcess(root string, state cutoverIntent, pid int) error {
	directory := "/proc/" + strconv.Itoa(pid)
	info, err := os.Stat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("release_cutover_process_identity_unavailable")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return nil
	}
	start, dead := processidentity.Start(pid)
	if dead {
		return nil
	}
	exe, err := os.Readlink(filepath.Join(directory, "exe"))
	if err != nil {
		if _, dead := processidentity.Start(pid); dead {
			return nil
		}
		return errors.New("release_cutover_process_identity_unavailable")
	}
	matched := legacyProcessPath(root, state, exe)
	if !matched && strings.Contains(exe, "/.mount_") {
		env, err := os.Open(filepath.Join(directory, "environ"))
		if err != nil {
			return errors.New("release_cutover_process_identity_unavailable")
		}
		const maximum = 1 << 20
		data, err := io.ReadAll(io.LimitReader(env, maximum+1))
		_ = env.Close()
		if err != nil || len(data) > maximum {
			return errors.New("release_cutover_process_identity_unavailable")
		}
		for _, entry := range strings.Split(string(data), "\x00") {
			if image, ok := strings.CutPrefix(entry, "APPIMAGE="); ok {
				matched = legacyProcessPath(root, state, image)
				break
			}
		}
	}
	end, dead := processidentity.Start(pid)
	if dead {
		return nil
	}
	current, err := os.Readlink(filepath.Join(directory, "exe"))
	if start == "" || end != start || err != nil || current != exe {
		return errors.New("release_cutover_process_identity_unavailable")
	}
	if matched {
		return errors.New("release_go_migration_owner_active")
	}
	return nil
}

func legacyProcessPath(root string, state cutoverIntent, name string) bool {
	name = strings.TrimSuffix(name, " (deleted)")
	if name == filepath.Join(root, "update", "maintenance") {
		return true
	}
	for _, old := range state.Legacy {
		canonical := filepath.Join(root, "generations", old.Version)
		quarantine := filepath.Join(root, "update", "go-cutover", state.TargetVersion, old.Version)
		if strings.HasPrefix(name, canonical+"/") || strings.HasPrefix(name, quarantine+"/") {
			return true
		}
	}
	return false
}
