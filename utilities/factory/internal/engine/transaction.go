package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

type routeTransaction struct {
	journal   *state.InstrumentationJournal
	id        string
	status    state.InstrumentationStatus
	repos     []transactionRepo
	scope     []transactionPath
	scopeFile string
}

// transaction открывает exact Linux-состояние либо создаёт его на открывающем узле.
// Проверка изоляции предшествует доступу к резервным копиям и запуску агента.
func (e execution) transaction(
	ctx context.Context, cursor state.StageSnapshot, begin bool,
) (*routeTransaction, error) {
	if runtime.GOOS != "linux" {
		return nil, fmt.Errorf("инструментация требует нативного подтверждения этой платформы")
	}
	j, err := e.request.Store.LockInstrumentation(e.attempt, begin)
	if err != nil {
		return nil, err
	}
	tx := &routeTransaction{journal: j}
	if err := e.admitTransaction(ctx, tx, cursor, begin); err != nil {
		j.Close()
		return nil, err
	}
	return tx, nil
}

// admitTransaction разрешает proof только с тем же exact active ID.
// При resume состояние cleaning читается для завершения очистки без повторного агента.
func (e execution) admitTransaction(
	ctx context.Context, tx *routeTransaction, cursor state.StageSnapshot, begin bool,
) error {
	id, err := tx.journal.Active()
	if err != nil {
		return err
	}
	if id == "" && !begin {
		return os.ErrNotExist
	}
	if id == "" && cursor.CurrentNode == "proof" {
		return fmt.Errorf("proof требует активную инструментацию. Верни курсор на instrument")
	}
	tx.repos, tx.status.Isolation, err = e.transactionRepos(ctx)
	if err != nil {
		return err
	}
	if id != "" {
		return e.loadTransactionScope(ctx, tx, id)
	}
	tx.id, err = tx.journal.Next(cursor.Sequence)
	if err != nil {
		return err
	}
	tx.scope, err = e.transactionScope(ctx)
	if err != nil {
		return err
	}
	tx.status.Phase = "active"
	return e.beginTransaction(ctx, tx)
}

// transactionRepos сверяет реальные Git metadata roots с закреплённым режимом.
// Shared primary допустим только при действующей аренде всех ресурсов попытки.
func (e execution) transactionRepos(ctx context.Context) ([]transactionRepo, string, error) {
	isolation := "exclusive-worktree-v1"
	if e.workspace.Mode == "shared" {
		isolation = "exclusive-shared-checkout-v1"
		if err := e.request.Store.SharedLease(e.attempt, e.workspace.Resources, "require"); err != nil {
			return nil, "", err
		}
	}
	var repos []transactionRepo
	for _, repo := range e.workspace.Repositories {
		args := []string{
			"rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--git-path", "index",
		}
		raw, err := e.git(ctx, repo.Worktree, args...)
		if err != nil {
			return nil, "", err
		}
		parts := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
		if len(parts) != 3 || !physicalTransactionDir(parts[0]) || !physicalTransactionDir(parts[1]) ||
			parts[2] != filepath.Join(parts[0], "index") {
			return nil, "", fmt.Errorf("недоверенный путь Git index")
		}
		gitDir, common := parts[0], parts[1]
		if (e.workspace.Mode == "shared" && gitDir != common) ||
			(e.workspace.Mode != "shared" && filepath.Dir(gitDir) != filepath.Join(common, "worktrees")) {
			return nil, "", fmt.Errorf("отсутствует требуемая изоляция рабочей копии")
		}
		source, err := e.git(ctx, repo.Source, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if err != nil || strings.TrimSuffix(string(source), "\n") != common {
			return nil, "", fmt.Errorf("рабочая копия ссылается на другой исходный репозиторий")
		}
		repos = append(repos, transactionRepo{repo.Worktree, parts[2]})
	}
	slices.SortFunc(repos, func(a, b transactionRepo) int { return strings.Compare(a.path, b.path) })
	return repos, isolation, nil
}

func physicalTransactionDir(path string) bool {
	resolved, err := filepath.EvalSymlinks(path)
	return err == nil && filepath.IsAbs(path) && resolved == path
}

// transactionScope превращает immutable scope попытки в canonical пути.
// Исторические короткие транзакции берут изменённые файлы из диффа и untracked.
func (e execution) transactionScope(ctx context.Context) ([]transactionPath, error) {
	var scope []transactionPath
	if e.artifacts.scope != "" {
		raw, _, err := e.request.Store.AttemptArtifact(e.attempt, "instrumentation-scope.tsv", nil, false)
		if err != nil {
			return nil, err
		}
		for line := range strings.SplitSeq(strings.TrimSuffix(string(raw), "\n"), "\n") {
			name, relative, found := strings.Cut(line, "\t")
			if !found || !validScopePath(relative) || !e.knownRepo(name) {
				return nil, fmt.Errorf("недоверенный закреплённый scope")
			}
			for _, repo := range e.workspace.Repositories {
				if repo.Name == name {
					scope = append(scope, transactionPath{repo.Worktree, relative})
				}
			}
		}
	} else {
		for _, repo := range e.workspace.Repositories {
			paths, err := e.derivedTransactionScope(ctx, repo.Worktree)
			if err != nil {
				return nil, err
			}
			scope = append(scope, paths...)
		}
	}
	if len(scope) == 0 {
		return nil, fmt.Errorf("для инструментации нужен непустой scope")
	}
	slices.SortFunc(scope, func(a, b transactionPath) int { return strings.Compare(a.absolute(), b.absolute()) })
	return slices.Compact(scope), nil
}

// derivedTransactionScope перечисляет изменённые файлы доверенного worktree.
// Служебные и секретные пути не становятся частью инструментации.
func (e execution) derivedTransactionScope(ctx context.Context, root string) ([]transactionPath, error) {
	var scope []transactionPath
	for _, args := range [][]string{
		{"diff", "--name-only", "--no-renames", "-z", "HEAD", "--"},
		{"ls-files", "--others", "--exclude-standard", "-z"},
	} {
		raw, err := e.git(ctx, root, args...)
		if err != nil {
			return nil, err
		}
		for _, relative := range sortedGitPaths(raw) {
			if validScopePath(relative) {
				scope = append(scope, transactionPath{root, relative})
			}
		}
	}
	return scope, nil
}

// loadTransactionScope связывает прежний Linux-журнал с repos текущего профиля.
// Explicit scope повторно проверяется по immutable артефакту попытки.
func (e execution) loadTransactionScope(ctx context.Context, tx *routeTransaction, id string) error {
	status, err := tx.journal.Status(id)
	if err != nil || status.Isolation != tx.status.Isolation {
		return fmt.Errorf("изоляция активной транзакции изменилась: %v", err)
	}
	raw, err := tx.journal.Read(id, "roots.list")
	if err != nil || string(raw) != transactionRoots(tx.repos) {
		return fmt.Errorf("roots.list не совпадает с закреплёнными рабочими копиями")
	}
	raw, err = tx.journal.Read(id, "scope.list")
	if err != nil {
		return err
	}
	for line := range strings.SplitSeq(strings.TrimSuffix(string(raw), "\n"), "\n") {
		path := transactionPath{}
		for _, repo := range tx.repos {
			if rel, found := strings.CutPrefix(line, repo.path+"/"); found && validScopePath(rel) {
				path = transactionPath{repo.path, rel}
				break
			}
		}
		if path.repo == "" {
			return fmt.Errorf("неверный сохранённый scope")
		}
		tx.scope = append(tx.scope, path)
	}
	if string(raw) != transactionScopeList(tx.scope) || !strictTransactionScope(tx.scope) {
		return fmt.Errorf("нарушен порядок сохранённого scope")
	}
	if e.artifacts.scope != "" {
		want, err := e.transactionScope(ctx)
		if err != nil || !slices.Equal(want, tx.scope) {
			return fmt.Errorf("сохранённый scope не совпадает с pin попытки")
		}
	}
	tx.status, tx.id = status, id
	return nil
}

func strictTransactionScope(scope []transactionPath) bool {
	for i := 1; i < len(scope); i++ {
		if scope[i-1].absolute() >= scope[i].absolute() {
			return false
		}
	}
	return len(scope) > 0
}

func transactionRoots(repos []transactionRepo) string {
	var result strings.Builder
	for _, repo := range repos {
		fmt.Fprintln(&result, repo.path)
	}
	return result.String()
}

func transactionScopeList(scope []transactionPath) string {
	var result strings.Builder
	for _, path := range scope {
		fmt.Fprintln(&result, path.absolute())
	}
	return result.String()
}

// beginTransaction сохраняет исходные объекты, Git index и точный снимок.
// Провайдер получает только scope в собственном контексте, control остаётся у хоста.
func (e execution) beginTransaction(ctx context.Context, tx *routeTransaction) error {
	if err := e.checkTransactionMarker(ctx, tx); err != nil {
		return err
	}
	before, err := e.transactionSnapshot(ctx, tx.repos, tx.scope)
	if err != nil {
		return err
	}
	files, err := tx.captureBackups()
	if err != nil {
		return err
	}
	after, err := e.transactionSnapshot(ctx, tx.repos, tx.scope)
	if err != nil || !bytes.Equal(before, after) {
		return fmt.Errorf("baseline изменился при сохранении: %v", err)
	}
	indexes, err := tx.indexFingerprints()
	if err != nil || !bytes.Equal(indexes, files["baseline.indexes"]) {
		return fmt.Errorf("исходный Git index изменился при сохранении: %v", err)
	}
	files["baseline.tsv"] = before
	files["expected.tsv"] = before
	files["roots.list"] = []byte(transactionRoots(tx.repos))
	files["scope.list"] = []byte(transactionScopeList(tx.scope))
	files["isolation"] = []byte(tx.status.Isolation + "\n")
	files["marker.b64"] = []byte(txnB64(e.transactionMarker()))
	return tx.journal.Begin(tx.id, files, tx.status)
}

// checkTransactionMarker проверяет Git-видимые файлы и явно объявленный scope.
// Код 1 от Git означает отсутствие маркера, прочие ошибки блокируют операцию.
func (e execution) checkTransactionMarker(ctx context.Context, tx *routeTransaction) error {
	marker := e.transactionMarker()
	for _, path := range tx.scope {
		object, err := readTransactionObject(path.absolute())
		if err != nil {
			return err
		}
		if bytes.Contains(object.data, []byte(marker)) {
			return fmt.Errorf("маркер инструментации уже присутствует в scope")
		}
	}
	for _, repo := range tx.repos {
		args := []string{"grep", "--untracked", "-Fq", "-e", marker, "--"}
		result := host.RunProcess(ctx, host.Process{Path: "git", Dir: repo.path, Args: args,
			Env: e.gitEnvironment(), Limit: 4096})
		if result.RC != 1 {
			return fmt.Errorf("маркер инструментации присутствует или проверка Git недоступна")
		}
	}
	return nil
}

func (e execution) transactionMarker() string {
	return "FACTORY-TRACE:t" + e.attempt.Task
}

// checkpoint сохраняет исход успешного guard. Чужая правка фиксирует stalled.
// expected обновляется до счётчика, а читатель проверяет согласованность всех записей.
func (e execution) checkpointTransaction(ctx context.Context, tx *routeTransaction) error {
	if tx.status.Phase != "active" {
		return fmt.Errorf("транзакция инструментации в состоянии %s", tx.status.Phase)
	}
	baseline, _, err := tx.snapshots()
	if err != nil {
		return err
	}
	current, err := e.transactionSnapshot(ctx, tx.repos, tx.scope)
	if err != nil {
		return tx.stall("snapshot_failed", err)
	}
	if err := compareTransactionScope(baseline, current, tx.scope); err != nil {
		return tx.stall("out_of_scope_change", err)
	}
	next := tx.status.Checkpoint + 1
	indexes, err := tx.indexFingerprints()
	if err != nil {
		return tx.stall("snapshot_failed", err)
	}
	if err := tx.journal.Write(tx.id, checkpointFile(next)+".indexes", indexes, false); err != nil {
		return err
	}
	if err := tx.journal.Write(tx.id, checkpointFile(next), current, false); err != nil {
		return err
	}
	if err := tx.journal.Write(tx.id, "expected.tsv", current, true); err != nil {
		return err
	}
	tx.status.Checkpoint = next
	return tx.journal.SetStatus(tx.id, tx.status)
}

func checkpointFile(checkpoint int64) string {
	return "checkpoint-" + strconv.FormatInt(checkpoint, 10) + ".tsv"
}

func (tx *routeTransaction) stall(reason string, cause error) error {
	tx.status.Phase, tx.status.Reason = "stalled", reason
	failure := fmt.Errorf("транзакция %s: %s: %w", tx.id, reason, cause)
	return errors.Join(failure, tx.journal.SetStatus(tx.id, tx.status))
}

// snapshots принимает только опубликованный expected и тот же номер checkpoint.
// Частичное продвижение счётчика оставляет данные для разбора.
func (tx *routeTransaction) snapshots() ([]byte, []byte, error) {
	baseline, err := tx.journal.Read(tx.id, "baseline.tsv")
	if err != nil {
		return nil, nil, err
	}
	expected, err := tx.journal.Read(tx.id, "expected.tsv")
	if err != nil && !(tx.status.Checkpoint == 0 && errors.Is(err, os.ErrNotExist)) {
		return nil, nil, err
	}
	confirmed := baseline
	if tx.status.Checkpoint != 0 {
		confirmed, err = tx.journal.Read(tx.id, checkpointFile(tx.status.Checkpoint))
		if err != nil {
			return nil, nil, err
		}
	}
	if expected != nil && !bytes.Equal(confirmed, expected) {
		return nil, nil, fmt.Errorf("expected не подтверждён тем же checkpoint")
	}
	return baseline, confirmed, nil
}
