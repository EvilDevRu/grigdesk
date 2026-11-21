package cleanup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

type candidate struct {
	entry
	inode      os.FileInfo
	fresh      time.Time
	generation bool
}

type measurement struct {
	bytes  int64
	newest time.Time
	locked string
}

var ignoredGeneration = regexp.MustCompile(`\.(?:release|stale|cleanup)-[0-9a-f]{32}$`)

func childRoot(parent *os.Root, name string, expected os.FileInfo) (*os.Root, error) {
	var err error
	if expected == nil {
		expected, err = parent.Lstat(name)
		if err != nil {
			return nil, err
		}
	}
	if !expected.IsDir() {
		return nil, errors.New("Каталог изменился.")
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	physical, statErr := root.Stat(".")
	if statErr != nil || !os.SameFile(expected, physical) {
		_ = root.Close()
		return nil, errors.New("Каталог изменился.")
	}
	return root, nil
}

func directoryNames(root *os.Root) ([]string, error) {
	dir, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	names, err := dir.Readdirnames(-1)
	slices.Sort(names)
	return names, err
}

func measure(ctx context.Context, root *os.Root, initial os.FileInfo, name string) (measurement, error) {
	if err := ctx.Err(); err != nil {
		return measurement{}, err
	}
	out := measurement{newest: initial.ModTime()}
	if _, err := root.Lstat("owner.json"); err == nil {
		out.locked = ownerStatus(readOwner(root))
	}
	names, err := directoryNames(root)
	if err != nil {
		return out, err
	}
	for _, child := range names {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		info, err := root.Lstat(child)
		if err != nil {
			return out, err
		}
		if info.ModTime().After(out.newest) {
			out.newest = info.ModTime()
		}
		if info.Mode().IsRegular() {
			out.bytes += info.Size()
		}
		if out.locked == "" && (lockName(child) || name == ".locks") {
			out.locked = lockStatus(root, child, nil)
		}
		if !info.IsDir() {
			continue
		}
		directory, err := childRoot(root, child, info)
		if err != nil {
			return out, err
		}
		tree, err := measure(ctx, directory, info, child)
		_ = directory.Close()
		if err != nil {
			return out, err
		}
		if tree.newest.After(out.newest) {
			out.newest = tree.newest
		}
		out.bytes += tree.bytes
		if out.locked == "" {
			out.locked = tree.locked
		}
	}
	return out, nil
}

func collect(ctx context.Context, root *os.Root, prefix, mode string) ([]candidate, error) {
	names, err := directoryNames(root)
	if err != nil {
		return nil, err
	}
	var result []candidate
	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		relative := filepath.Join(prefix, name)
		info, err := root.Lstat(name)
		if err != nil {
			result = append(result, candidate{entry: skipped(relative, nil, "io-error")})
			continue
		}
		switch {
		case lockName(name), name == ".locks":
			result = append(result, candidate{entry: skipped(relative, nil, "locked")})
		case !info.IsDir():
			reason := "not-directory"
			if info.Mode()&os.ModeSymlink != 0 {
				reason = "symlink"
			}
			result = append(result, candidate{entry: skipped(relative, nil, reason)})
		case mode == "root" && name == "chat-runs":
			result = append(result, candidate{entry: skipped(relative, nil, "current")})
		default:
			next := relatedMode(mode, name)
			if next == "preserve" {
				result = append(result, candidate{entry: skipped(relative, nil, "protected-cache")})
				continue
			}
			directory, err := childRoot(root, name, info)
			if err != nil {
				result = append(result, candidate{entry: skipped(relative, nil, "disappeared")})
				continue
			}
			if next != "" {
				inside, err := collect(ctx, directory, relative, next)
				_ = directory.Close()
				result = append(result, inside...)
				if err != nil {
					result = append(result, candidate{entry: skipped(relative, nil, "io-error")})
				}
				continue
			}
			tree, err := measure(ctx, directory, info, name)
			_ = directory.Close()
			if err != nil {
				result = append(result, candidate{entry: skipped(relative, nil, "io-error")})
				continue
			}
			item := candidate{
				entry: entry{Path: relative, Bytes: &tree.bytes, Reason: reasonText(tree.locked)},
				inode: info, fresh: tree.newest, generation: mode == "generations" && !ignoredGeneration.MatchString(name),
			}
			result = append(result, item)
		}
	}
	return result, nil
}

func relatedMode(parent, name string) string {
	switch parent {
	case "root":
		if name == "deepseek-binary" {
			return "theme"
		}
	case "theme":
		if name == "node-cache" {
			return "cache"
		}
		if slices.Contains([]string{"test-builds", "gates", "build-input-tests", "explicit-cache"}, name) {
			return "children"
		}
	case "cache":
		if name == "generations" {
			return "generations"
		}
		return "preserve"
	}
	return ""
}

// protectedGenerations выбирает последние K физических поколений по полной свежести.
func protectedGenerations(candidates []candidate, count int) map[string]bool {
	var generations []candidate
	for _, item := range candidates {
		if item.generation {
			generations = append(generations, item)
		}
	}
	slices.SortFunc(generations, func(a, b candidate) int {
		if !a.fresh.Equal(b.fresh) {
			return b.fresh.Compare(a.fresh)
		}
		return strings.Compare(a.Path, b.Path)
	})
	out := make(map[string]bool)
	for index := range min(count, len(generations)) {
		out[generations[index].Path] = true
	}
	return out
}
