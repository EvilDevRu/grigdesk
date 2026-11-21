package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/runner"
)

// workspaceGuard ограничивает каждый запуск собственной парой снимков.
// Изменение checkout прекращает dispatch до повтора или перехода к failover.
func (e execution) workspaceGuard(
	ctx context.Context, accepted func(runner.DispatchResult),
) (func(string) (string, error), func(runner.DispatchResult) error) {
	var baseline []byte
	before := func(prompt string) (string, error) {
		var err error
		baseline, err = e.snapshotWorkspace(ctx)
		return prompt, err
	}
	after := func(result runner.DispatchResult) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		current, err := e.snapshotWorkspace(ctx)
		if err != nil || !bytes.Equal(baseline, current) {
			return fmt.Errorf("workspace guard: агент изменил checkout или снимок недоступен")
		}
		if accepted != nil {
			accepted(result)
		}
		return nil
	}
	return before, after
}

// snapshotWorkspace сравнивает HEAD, индекс, tracked diff и untracked содержимое.
// Ошибка любого чтения блокирует commit, снимок не изменяет checkout.
func (e execution) snapshotWorkspace(ctx context.Context) ([]byte, error) {
	result := sha256.New()
	for _, repo := range e.workspace.Repositories {
		root, err := os.OpenRoot(repo.Worktree)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(result, "%s\x00%s\x00", repo.Name, repo.Worktree)
		err = e.snapshotRepository(ctx, root, repo.Worktree, result)
		closeErr := root.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
	}
	return result.Sum(nil), nil
}

func (e execution) snapshotRepository(
	ctx context.Context, root *os.Root, dir string, result io.Writer,
) error {
	head, err := e.git(ctx, dir, "rev-parse", "--verify", "HEAD")
	args := []string{"diff", "--binary", "--no-ext-diff", "--no-textconv"}
	if err == nil {
		args = append(args, "HEAD")
	} else {
		head = []byte("UNBORN")
	}
	result.Write(head)
	commands := [][]string{append(args, "--"), {"diff", "--cached", "--binary", "--no-ext-diff", "--"}}
	for _, command := range commands {
		raw, err := e.git(ctx, dir, command...)
		if err != nil {
			return err
		}
		fmt.Fprintf(result, "%x\x00", sha256.Sum256(raw))
	}
	untracked, err := e.git(ctx, dir, "ls-files", "-z", "--others", "--exclude-standard")
	if err != nil {
		return err
	}
	for name := range strings.SplitSeq(string(untracked), "\x00") {
		if name == "" {
			continue
		}
		if err := hashGuardFile(root, name, result); err != nil {
			return err
		}
	}
	return nil
}

func hashGuardFile(root *os.Root, name string, result io.Writer) error {
	if !filepath.IsLocal(name) || filepath.Clean(name) != name {
		return fmt.Errorf("workspace guard: путь checkout выходит из корня")
	}
	info, err := root.Lstat(name)
	if err != nil {
		return err
	}
	fmt.Fprintf(result, "%s\x00%v\x00", name, info.Mode())
	if info.Mode()&os.ModeSymlink != 0 {
		link, err := root.Readlink(name)
		if err != nil {
			return err
		}
		fmt.Fprintf(result, "%s\x00", link)
		return nil
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("workspace guard: неизвестный тип файла checkout")
	}
	file, err := root.Open(name)
	if err != nil {
		return err
	}
	defer file.Close()
	current, err := file.Stat()
	if err != nil || !os.SameFile(info, current) {
		return fmt.Errorf("workspace guard: файл заменён при чтении")
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return err
	}
	fmt.Fprintf(result, "%x\x00", digest.Sum(nil))
	return nil
}
