package source

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/ctl/internal/cleanup"
	"grigdesk.local/tools/utilities/ctl/internal/service"
)

type buildLog struct {
	Name    string
	file    *os.File
	data    string
	mutex   sync.Mutex
	timings []stageTiming
	release func()
}

func openBuildLog(settings service.Settings) (*buildLog, error) {
	directory := filepath.Join(settings.DataHome, "artifacts", "ctl-build")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(directory); err != nil || !info.IsDir() {
		return nil, errors.New("Каталог ctl-build недоступен.")
	}
	prefix := fmt.Sprintf("build-%s-%d-*.log", time.Now().UTC().Format("20060102T150405.000Z"), os.Getpid())
	file, err := os.CreateTemp(directory, prefix)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		return nil, err
	}
	release, err := cleanup.HoldArtifact(file.Name())
	if err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, err
	}
	link := file.Name() + ".latest"
	if err := os.Symlink(filepath.Base(file.Name()), link); err != nil {
		release()
		_ = file.Close()
		return nil, err
	}
	defer os.Remove(link)
	if err := os.Rename(link, filepath.Join(directory, "latest.log")); err != nil {
		release()
		_ = file.Close()
		return nil, err
	}
	rotateLogs(directory)
	return &buildLog{Name: file.Name(), file: file, data: settings.DataHome, release: release}, nil
}

// rotateLogs оставляет последние журналы и не удаляет файл другого активного сборщика.
func rotateLogs(directory string) {
	items, _ := filepath.Glob(filepath.Join(directory, "build-*.log"))
	sort.Sort(sort.Reverse(sort.StringSlice(items)))
	if len(items) <= 10 {
		return
	}
	for _, item := range items[10:] {
		info, err := os.Lstat(item)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		locked, err := os.OpenFile(item, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			continue
		}
		if syscall.Flock(int(locked.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil {
			_ = os.Remove(item)
		}
		_ = locked.Close()
	}
}

func (log *buildLog) Write(data []byte) (int, error) {
	log.mutex.Lock()
	defer log.mutex.Unlock()
	return log.file.Write(data)
}

func (log *buildLog) Record(id string, elapsed time.Duration) {
	log.mutex.Lock()
	defer log.mutex.Unlock()
	log.timings = append(log.timings, stageTiming{ID: id, DurationMS: max(1, elapsed.Milliseconds())})
}

func (log *buildLog) Close() {
	_ = log.file.Close()
	log.release()
}

func (log *buildLog) Tail() string {
	data, err := os.ReadFile(log.Name)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	lines = lines[max(0, len(lines)-20):]
	for index, line := range lines {
		lines[index] = service.Printable(line)
	}
	return strings.Join(lines, "\n") + "\n"
}

func (log *buildLog) Finish(target string, rc int) {
	_ = log.file.Sync()
	if rc != 0 {
		return
	}
	directory := filepath.Join(log.data, "state")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return
	}
	historyFile := filepath.Join(directory, "ctl-build-timings.json")
	lock, err := os.OpenFile(historyFile+".lock", os.O_CREATE|os.O_RDONLY|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return
	}
	defer lock.Close()
	if syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return
	}
	history := buildHistory{Version: 1}
	if data, err := os.ReadFile(historyFile); err == nil {
		if json.Unmarshal(data, &history) != nil || history.Version != 1 {
			history = buildHistory{Version: 1}
		}
	}
	if history.Variants == nil {
		history.Variants = make(map[string][]stageTiming)
	}
	history.Variants[target] = log.timings
	temporary, err := os.CreateTemp(directory, ".ctl-build-timings-*")
	if err != nil {
		return
	}
	defer os.Remove(temporary.Name())
	err = json.NewEncoder(temporary).Encode(history)
	synced := temporary.Sync()
	closed := temporary.Close()
	if err == nil && synced == nil && closed == nil {
		_ = os.Rename(temporary.Name(), historyFile)
	}
}
