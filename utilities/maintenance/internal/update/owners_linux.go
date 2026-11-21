package update

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

	"golang.org/x/sys/unix"

	"grigdesk.local/tools/utilities/internal/installation"
	"grigdesk.local/tools/utilities/internal/processidentity"
)

func processPath(pid int) (string, string, error) {
	dir := "/proc/" + strconv.Itoa(pid)
	info, err := os.Stat(dir)
	if err != nil {
		return "", "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return "", "", os.ErrPermission
	}
	exe, err := os.Readlink(filepath.Join(dir, "exe"))
	if err != nil {
		return "", "", err
	}
	if !strings.Contains(exe, "/.mount_") {
		return exe, exe, nil
	}
	file, err := os.Open(filepath.Join(dir, "environ"))
	if err != nil {
		return "", "", err
	}
	defer file.Close()
	const limit = 1 << 20
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || len(data) > limit {
		return "", "", errors.New("release_process_owner_invalid")
	}
	for _, entry := range strings.Split(string(data), "\x00") {
		if path, ok := strings.CutPrefix(entry, "APPIMAGE="); ok &&
			filepath.IsAbs(path) && !strings.HasPrefix(path, "/proc/") {
			return exe, path, nil
		}
	}
	image, err := heldAppImage(dir, exe)
	if err != nil || image != "" {
		return exe, image, err
	}
	return exe, exe, nil
}

// heldAppImage подтверждает файл, удержанный проверенным fd запуска.
// Electron может убрать APPIMAGE из начального окружения процесса при запуске.
func heldAppImage(proc, executable string) (string, error) {
	if filepath.Base(executable) != "grigdesk" {
		return "", nil
	}
	var mount unix.Statfs_t
	if err := unix.Statfs(filepath.Dir(executable), &mount); err != nil {
		return "", err
	}
	if mount.Type != unix.FUSE_SUPER_MAGIC {
		return "", nil
	}
	dir := filepath.Join(proc, "fd")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) > 1<<16 {
		return "", errors.New("release_process_owner_invalid")
	}
	var image string
	for _, entry := range entries {
		fd := filepath.Join(dir, entry.Name())
		path, err := os.Readlink(fd)
		if err != nil || filepath.Base(path) != "GrigDesk" || !filepath.IsAbs(path) ||
			filepath.Clean(path) != path || !matchesHeldAppImage(fd, path) {
			continue
		}
		if image != "" && image != path {
			return "", errors.New("release_process_owner_invalid")
		}
		image = path
	}
	return image, nil
}

// matchesHeldAppImage сверяет inode открытого fd с физическим файлом установки.
// Строка пути, подставленная в окружение, не доказывает эту связь.
func matchesHeldAppImage(fd, path string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0555 {
		return false
	}
	file, err := os.OpenFile(fd, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return false
	}
	defer file.Close()
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		return false
	}
	var header [11]byte
	_, err = file.ReadAt(header[:], 0)
	return err == nil && string(header[:4]) == "\x7fELF" && string(header[8:]) == "AI\x02"
}

func validOwner(ctx context.Context, root, relative string, owner Process) bool {
	if ctx.Err() != nil || owner.PID <= 0 || owner.Starttime == "" {
		return false
	}
	start, dead := processidentity.Start(owner.PID)
	if dead || start != owner.Starttime {
		return false
	}
	exe, path, err := processPath(owner.PID)
	if err != nil || exe != owner.Executable || !strings.HasPrefix(path, filepath.Join(root, relative)+"/") {
		return false
	}
	now, dead := processidentity.Start(owner.PID)
	return !dead && start == now
}

func previousOwnersStopped(ctx context.Context, layout *installation.Layout, job *Job, saved *Handoff) error {
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	entries, err := os.ReadDir("/proc")
	if err != nil || len(entries) > 1<<16 {
		return errors.New("release_process_owner_invalid")
	}
	for _, entry := range entries {
		if deadline.Err() != nil {
			return errors.New("release_process_owner_invalid")
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		start, dead := processidentity.Start(pid)
		if dead || start == "" {
			continue
		}
		_, path, err := processPath(pid)
		if err != nil {
			if errors.Is(err, os.ErrPermission) {
				continue
			}
			if _, dead := processidentity.Start(pid); dead {
				continue
			}
			return errReleaseOwnerScanUnresolved
		}
		for _, part := range []string{"desktop", "server"} {
			relative := component(job.Previous, part)
			if relative == nil || part == "desktop" && job.Scope == "server" ||
				part == "server" && !saved.StopLocal {
				continue
			}
			if strings.HasPrefix(path, filepath.Join(layout.Receipt.Root, *relative)+"/") {
				return errReleaseOwnerActive
			}
		}
	}
	return nil
}

func observeProcess(ctx context.Context, pid int) (Process, error) {
	start, dead := processidentity.Start(pid)
	exe, _, err := processPath(pid)
	end, exited := processidentity.Start(pid)
	if dead || exited || err != nil || ctx.Err() != nil || start == "" || end != start {
		return Process{}, errors.New("release_process_owner_invalid")
	}
	return Process{PID: pid, Starttime: start, Executable: exe}, nil
}

func processParent(pid int) int {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0
	}
	text := string(data)
	fields := strings.Fields(text[strings.LastIndex(text, ")")+1:])
	if len(fields) < 2 {
		return 0
	}
	parent, _ := strconv.Atoi(fields[1])
	return parent
}

func stopManualProcess(ctx context.Context, owner Process) error {
	fd, err := unix.PidfdOpen(owner.PID, 0)
	if err != nil {
		return errors.New("release_server_owner_invalid")
	}
	defer unix.Close(fd)
	current, err := observeProcess(ctx, owner.PID)
	if err != nil || current != owner {
		return errors.New("release_server_owner_invalid")
	}
	return unix.PidfdSendSignal(fd, unix.SIGTERM, nil, 0)
}
