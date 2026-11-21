package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
)

type transactionRepo struct {
	path, index string
}

type transactionPath struct {
	repo, relative string
}

func (path transactionPath) absolute() string {
	return filepath.Join(path.repo, path.relative)
}

type transactionObject struct {
	data []byte
	mode os.FileMode
	info os.FileInfo
}

const transactionObjectLimit = 64 * 1024 * 1024

// readTransactionObject подтверждает физический обычный файл или его отсутствие.
// Ссылка, переименование при чтении и объект с чужим inode останавливают восстановление.
func readTransactionObject(path string) (transactionObject, error) {
	parent := filepath.Dir(path)
	physical, err := filepath.EvalSymlinks(parent)
	if err != nil || physical != parent {
		return transactionObject{}, fmt.Errorf("повреждён родитель файла инструментации")
	}
	root, err := os.OpenRoot(parent)
	if err != nil {
		return transactionObject{}, err
	}
	defer root.Close()
	return readTransactionAt(root, filepath.Base(path))
}

// readTransactionAt читает ограниченный снимок через открытый каталог.
// Имя проверяется до и после чтения, включая режим, число ссылок и inode.
func readTransactionAt(root *os.Root, name string) (transactionObject, error) {
	file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		return transactionObject{}, nil
	}
	if err != nil {
		return transactionObject{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !regularTransactionFile(info) {
		return transactionObject{}, fmt.Errorf("недопустимый тип или размер файла инструментации")
	}
	raw, err := io.ReadAll(io.LimitReader(file, transactionObjectLimit+1))
	if err != nil {
		return transactionObject{}, err
	}
	after, err := root.Lstat(name)
	if err != nil || !sameTransactionFile(info, after) || int64(len(raw)) != info.Size() {
		return transactionObject{}, fmt.Errorf("файл инструментации изменился при чтении")
	}
	return transactionObject{data: raw, mode: info.Mode().Perm(), info: info}, nil
}

func regularTransactionFile(info os.FileInfo) bool {
	if info == nil || !info.Mode().IsRegular() || info.Mode()&^os.ModePerm != 0 {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && st.Nlink == 1 && info.Size() <= transactionObjectLimit
}

func sameTransactionFile(before, after os.FileInfo) bool {
	return regularTransactionFile(after) && os.SameFile(before, after) &&
		before.ModTime() == after.ModTime() && before.Size() == after.Size() && before.Mode() == after.Mode()
}

func txnDigest(raw []byte) string {
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

func txnB64(value string) string {
	return base64.StdEncoding.EncodeToString([]byte(value))
}

func (obj transactionObject) fields() (mode, hash string) {
	if obj.info == nil {
		return "-", "-"
	}
	return strconv.FormatUint(uint64(obj.mode), 8), txnDigest(obj.data)
}

// transactionSnapshot публикует Linux workspace guard в прежнем TSV-формате.
// Отдельные пути позволяют сравнить снимки без объявленных файлов инструментации.
func (e execution) transactionSnapshot(
	ctx context.Context, repos []transactionRepo, scope []transactionPath,
) ([]byte, error) {
	var out bytes.Buffer
	fmt.Fprintln(&out, "SCHEMA\t1")
	for _, repo := range repos {
		if err := e.transactionRepoSnapshot(ctx, repo.path, &out); err != nil {
			return nil, err
		}
	}
	for _, path := range scope {
		obj, err := readTransactionObject(path.absolute())
		if err != nil {
			return nil, fmt.Errorf("unsafe_scope_object: %w", err)
		}
		if obj.info != nil {
			mode, hash := obj.fields()
			fmt.Fprintf(&out, "SENSITIVE\t%s\t%s\tfile\t%s\t%s\t\n",
				txnB64(path.repo), txnB64(path.relative), mode, hash)
		}
	}
	return out.Bytes(), nil
}

// transactionRepoSnapshot фиксирует HEAD, diff index/worktree и пути вне Git.
// Ошибка Git прекращает снимок, поэтому частичный список не считается доказательством.
func (e execution) transactionRepoSnapshot(ctx context.Context, root string, out *bytes.Buffer) error {
	head, err := e.git(ctx, root, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return err
	}
	root64 := txnB64(root)
	fmt.Fprintf(out, "ROOT\t%s\nHEAD\t%s\t%s\n", root64, root64, bytes.TrimSpace(head))
	if err := e.checkTransactionIndexFlags(ctx, root); err != nil {
		return err
	}
	for _, diff := range []struct{ aggregate, revision string }{
		{"WORKTREE_DIFF", "HEAD"},
		{"INDEX_DIFF", "--cached"},
	} {
		raw, err := e.git(ctx, root, "diff", "--binary", "--no-ext-diff", diff.revision, "--")
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s\t%s\t%s\n", diff.aggregate, root64, txnDigest(raw))
	}
	for _, diff := range []struct{ entry, revision string }{
		{"TRACKED_WORKTREE", "HEAD"}, {"TRACKED_INDEX", "--cached"},
	} {
		if err := e.transactionDiff(ctx, root, diff.entry, diff.revision, out); err != nil {
			return err
		}
	}
	files, err := e.git(ctx, root, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return err
	}
	for _, name := range sortedGitPaths(files) {
		row, err := untrackedTransactionRow(root, name)
		if err != nil {
			return err
		}
		out.WriteString(row)
	}
	return nil
}

// checkTransactionIndexFlags отклоняет флаги, скрывающие содержимое из Git diff.
// Иначе изменение вне scope могло бы пройти покомпонентное сравнение.
func (e execution) checkTransactionIndexFlags(ctx context.Context, root string) error {
	raw, err := e.git(ctx, root, "ls-files", "-v", "-z")
	if err != nil {
		return err
	}
	for _, line := range sortedGitPaths(raw) {
		if !strings.HasPrefix(line, "H ") {
			return fmt.Errorf("Git index содержит скрытую или конфликтующую запись")
		}
	}
	return nil
}

// transactionDiff получает индивидуальные Git-отпечатки изменённых путей.
// Literal pathspec сохраняет точное имя файла с метасимволами.
func (e execution) transactionDiff(ctx context.Context, root, kind, rev string, out *bytes.Buffer) error {
	files, err := e.git(ctx, root, "diff", "--name-only", "-z", "--no-ext-diff", "--no-renames", rev, "--")
	if err != nil {
		return err
	}
	for _, name := range sortedGitPaths(files) {
		raw, err := e.git(ctx, root, "--literal-pathspecs", "diff", "--binary", "--no-ext-diff",
			"--no-renames", rev, "--", name)
		if err != nil {
			return err
		}
		if len(raw) == 0 {
			continue
		}
		fmt.Fprintf(out, "%s\t%s\t%s\t%s\n", kind, txnB64(root), txnB64(name), txnDigest(raw))
	}
	return nil
}

func sortedGitPaths(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	names := strings.Split(strings.TrimSuffix(string(raw), "\x00"), "\x00")
	slices.Sort(names)
	return slices.Compact(names)
}

// untrackedTransactionRow учитывает содержимое обычного файла или цель ссылки.
// Сторож никогда не раскрывает цель чтением по symlink.
func untrackedTransactionRow(root, relative string) (string, error) {
	if !filepath.IsLocal(relative) || filepath.Clean(relative) != relative {
		return "", fmt.Errorf("неканонический untracked путь")
	}
	path := filepath.Join(root, relative)
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(path)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("UNTRACKED\t%s\t%s\tsymlink\t%o\t%s\t%s\n",
			txnB64(root), txnB64(relative), info.Mode().Perm(), txnDigest([]byte(target)), txnB64(target)), nil
	}
	obj, err := readTransactionObject(path)
	if err != nil || obj.info == nil || !os.SameFile(info, obj.info) {
		return "", fmt.Errorf("недоверенный untracked объект: %w", err)
	}
	mode, hash := obj.fields()
	return fmt.Sprintf("UNTRACKED\t%s\t%s\tfile\t%s\t%s\t\n",
		txnB64(root), txnB64(relative), mode, hash), nil
}
