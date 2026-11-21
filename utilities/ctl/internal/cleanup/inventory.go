package cleanup

import (
	"cmp"
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
)

type inventoryEntry struct {
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	Bytes      int64  `json:"bytes"`
	ErrorCount int    `json:"errorCount"`
}

type inventoryGroup struct {
	Kind  string `json:"kind"`
	Bytes int64  `json:"bytes"`
}

type inventoryReport struct {
	Format      int              `json:"format"`
	Root        string           `json:"root"`
	Topic       string           `json:"topic,omitempty"`
	TotalBytes  int64            `json:"totalBytes"`
	Groups      []inventoryGroup `json:"groups"`
	Entries     []inventoryEntry `json:"entries"`
	ErrorCount  int              `json:"errorCount"`
	Interrupted bool             `json:"interrupted"`
}

type inventoryWalk struct {
	ctx    context.Context
	device uint64
	seen   map[uint64]bool
}

var errInventoryTopic = errors.New("inventory.invalidTopic")
var errInventoryFilters = errors.New("inventory.invalidFilters")
var releaseTopic = regexp.MustCompile(`^release-[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?$`)

func validInventoryTopic(name string) bool {
	return filepath.IsLocal(name) && filepath.Base(name) == name && name != "." &&
		!strings.HasPrefix(name, "--") && !strings.ContainsRune(name, 0)
}

// inventoryKind берёт категорию только из известных имён тем верхнего уровня.
// Категория описывает назначение темы и ничего не говорит о возможности её удаления.
func inventoryKind(topic string) string {
	switch topic {
	case "chat-runs":
		return "chat-runs"
	case "factory-go":
		return "factory-checks"
	case "lightweight-installer", "provider-install-probes":
		return "installer-checks"
	case "deepseek-binary":
		return "runtime-checks"
	case "ctl-build":
		return "builds"
	}
	if releaseTopic.MatchString(topic) {
		return "release"
	}
	if strings.HasPrefix(topic, "dist-build-") {
		return "builds"
	}
	return "other"
}

// measure суммирует выделенные блоки в пределах одного устройства.
// Ссылки учитываются только по собственным блокам. Ошибка отдельной ветки сохраняет частичный размер.
func (walk inventoryWalk) measure(parent *os.Root, name string, row *inventoryEntry) {
	info, err := parent.Lstat(name)
	if err != nil {
		row.ErrorCount++
		return
	}
	stat := info.Sys().(*syscall.Stat_t)
	if uint64(stat.Dev) != walk.device {
		return
	}
	if info.IsDir() || stat.Nlink > 1 {
		if walk.seen[stat.Ino] {
			return
		}
		walk.seen[stat.Ino] = true
	}
	row.Bytes += int64(stat.Blocks) * 512
	if !info.IsDir() {
		return
	}

	directory, err := childRoot(parent, name, info)
	if err != nil {
		row.ErrorCount++
		return
	}
	defer directory.Close()
	walk.children(directory, row)
}

// children продолжает обход соседей после ошибки чтения отдельной ветки.
// Проверка контекста ограничивает работу после отмены текущим обращением к диску.
func (walk inventoryWalk) children(directory *os.Root, row *inventoryEntry) {
	names, err := directoryNames(directory)
	if err != nil {
		row.ErrorCount++
	}
	for _, name := range names {
		if walk.ctx.Err() != nil {
			return
		}
		walk.measure(directory, name, row)
	}
}

// scanInventory закрепляет корень и выбранную тему по дескриптору.
// Отчёт строится из метаданных и никогда не вызывает проверку кандидатов на удаление.
func scanInventory(ctx context.Context, path, topic string) (inventoryReport, error) {
	report := inventoryReport{
		Format: 1, Root: path, Topic: topic, Entries: []inventoryEntry{}, Groups: []inventoryGroup{},
	}
	if ctx.Err() != nil {
		report.Interrupted = true
		return report, nil
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) && topic == "" {
		return report, nil
	}
	if err != nil {
		return report, err
	}
	parent, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return report, err
	}
	defer parent.Close()
	root, err := childRoot(parent, filepath.Base(path), info)
	if err != nil {
		return report, err
	}
	defer root.Close()
	if topic != "" {
		root, err = childRoot(root, topic, nil)
		if err != nil {
			return report, err
		}
		defer root.Close()
		info, err = root.Stat(".")
		if err != nil {
			return report, err
		}
	}

	stat := info.Sys().(*syscall.Stat_t)
	walk := inventoryWalk{ctx: ctx, device: uint64(stat.Dev), seen: map[uint64]bool{stat.Ino: true}}
	report.collect(walk, root)
	return report, nil
}

// collect группирует строки после обхода и оставляет недоступные пути в отчёте.
// Равные размеры сортируются детерминированно по имени.
func (report *inventoryReport) collect(walk inventoryWalk, root *os.Root) {
	names, err := directoryNames(root)
	if err != nil {
		report.ErrorCount++
	}
	totals := make(map[string]int64)
	for _, name := range names {
		if walk.ctx.Err() != nil {
			break
		}
		topic := report.Topic
		if topic == "" {
			topic = name
		}
		row := inventoryEntry{Path: name, Kind: inventoryKind(topic)}
		walk.measure(root, name, &row)
		report.Entries = append(report.Entries, row)
		report.TotalBytes += row.Bytes
		report.ErrorCount += row.ErrorCount
		totals[row.Kind] += row.Bytes
	}
	report.Interrupted = walk.ctx.Err() != nil

	for kind, bytes := range totals {
		report.Groups = append(report.Groups, inventoryGroup{Kind: kind, Bytes: bytes})
	}
	slices.SortFunc(report.Groups, func(a, b inventoryGroup) int {
		return compareInventory(a.Bytes, b.Bytes, a.Kind, b.Kind)
	})
	slices.SortFunc(report.Entries, func(a, b inventoryEntry) int {
		return compareInventory(a.Bytes, b.Bytes, a.Path, b.Path)
	})
}

func compareInventory(left, right int64, first, second string) int {
	if left != right {
		return cmp.Compare(right, left)
	}
	return strings.Compare(first, second)
}
