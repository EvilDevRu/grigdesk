package hooks

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

type StandRequest struct {
	Invocation Invocation
	Task       string
	Mode       string
	Owner      string
	StateFile  string
	EarlyFile  string
	Resume     bool
	EarlyReady func([]byte) error
}

// checkWorkingDirectory требует явно выбранный физический рабочий каталог.
// Вызов хука не унаследует cwd управляющего процесса.
func checkWorkingDirectory(dir string) error {
	if !filepath.IsAbs(dir) || filepath.Clean(dir) != dir || strings.ContainsAny(dir, "\n\t") {
		return fmt.Errorf("cwd: нужен канонический абсолютный каталог")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("cwd: нужен физический каталог")
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil || resolved != dir {
		return fmt.Errorf("cwd: symlink-компоненты запрещены")
	}
	return nil
}

// PrepareStand ожидает отдельные подтверждения рабочего дерева и готовности сервисов.
// Повтор после частичного подъёма завершается отказом до запуска up.sh.
func PrepareStand(ctx context.Context, req StandRequest) (int, error) {
	if !commandTask.MatchString(req.Task) {
		return 78, fmt.Errorf("стенд: неверный TASK")
	}
	if req.Mode == "shared" {
		if req.Owner != "external" {
			return 75, fmt.Errorf("стенд: ресурсы shared принадлежат другому владельцу")
		}
		return standHealth(ctx, req)
	}
	if req.Mode != "isolated" || req.Owner != "task" {
		return 78, fmt.Errorf("стенд: не подтверждено владение isolated")
	}
	return prepareIsolated(ctx, req)
}

// prepareIsolated проверяет прежнюю подготовку до вызова up.sh.
// Незавершённый intent блокирует повтор даже при наличии побочной проекции.
func prepareIsolated(ctx context.Context, req StandRequest) (int, error) {
	if !filepath.IsAbs(req.StateFile) || filepath.Clean(req.StateFile) != req.StateFile {
		return 78, fmt.Errorf("стенд: нужен канонический путь проекции")
	}
	intent := ""
	if req.EarlyFile != "" {
		if err := checkWorkingDirectory(filepath.Dir(req.EarlyFile)); err != nil {
			return 78, err
		}
		intent = req.EarlyFile + ".intent"
		if _, err := os.Lstat(intent); !os.IsNotExist(err) {
			return 75, fmt.Errorf("стенд: сохранилась незавершённая подготовка")
		}
	}
	if _, err := readStandDescriptor(req.StateFile, req.Task); err == nil {
		return standHealth(ctx, req)
	} else if !os.IsNotExist(err) {
		return 75, err
	}
	if req.Resume {
		return 73, fmt.Errorf("стенд: ожидается восстановление сервером перед resume")
	}
	if intent == "" {
		return 78, fmt.Errorf("стенд: нужен адрес доверенной подготовки")
	}
	if _, err := os.Lstat(req.EarlyFile); !os.IsNotExist(err) {
		return 75, fmt.Errorf("стенд: найден прежний ранний descriptor")
	}
	if err := reserveStand(intent, req.Task); err != nil {
		return 75, err
	}
	rc, err := provisionIsolated(ctx, req)
	if err != nil {
		return rc, err
	}
	if err := os.Remove(intent); err != nil {
		return 1, err
	}
	return 0, nil
}

// reserveStand фиксирует единственного владельца незавершённого up.
// После отказа файл остаётся для штатной диагностики и ручного восстановления.
func reserveStand(path, task string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("стенд: подготовка уже занята: %w", err)
	}
	_, writeErr := fmt.Fprintln(file, task)
	return errors.Join(writeErr, file.Sync(), file.Close())
}

// provisionIsolated следит за опубликованным ранним descriptor независимо от up.sh.
// Main открывается только после нулевого exit, точного финального descriptor и health.
func provisionIsolated(parent context.Context, req StandRequest) (int, error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	pending := make(chan host.ProcessResult, 1)
	go func() {
		pending <- runStandScript(ctx, req, "up.sh")
	}()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	var early []byte
	for {
		select {
		case result := <-pending:
			if err := hookFailure("up.sh", result); err != nil {
				return result.RC, err
			}
			final, err := readStandDescriptor(req.StateFile, req.Task)
			if err != nil {
				return 78, fmt.Errorf("стенд: не получен итоговый descriptor: %w", err)
			}
			if early != nil && !bytes.Equal(early, final) {
				return 75, fmt.Errorf("стенд: ранний и итоговый descriptor различаются")
			}
			return standHealth(parent, req)
		case <-tick.C:
			if early != nil || req.EarlyReady == nil {
				continue
			}
			data, err := readStandDescriptor(req.EarlyFile, req.Task)
			if os.IsNotExist(err) {
				continue
			}
			if err == nil {
				err = req.EarlyReady(data)
			}
			if err != nil {
				cancel()
				result := <-pending
				if result.RC == 75 {
					return 75, errors.Join(err, hookFailure("up.sh", result))
				}
				return 78, err
			}
			early = data
		}
	}
}

// runStandScript запускает только известный профильный entrypoint.
// Состояние и каналы подготовки передаются явно, без запуска через eval.
func runStandScript(ctx context.Context, req StandRequest, name string) host.ProcessResult {
	invocation := req.Invocation
	if err := CheckFile(invocation.Profile, "profile"); err != nil {
		return host.ProcessResult{RC: 78, Err: err}
	}
	if err := checkWorkingDirectory(invocation.Directory); err != nil {
		return host.ProcessResult{RC: 78, Err: err}
	}
	script := filepath.Join(filepath.Dir(invocation.Profile), name)
	if err := CheckFile(script, name); err != nil {
		return host.ProcessResult{RC: 78, Err: err}
	}
	state := filepath.Dir(req.StateFile)
	env := append(hookEnvironment(invocation.Env), "STATE_DIR="+state, "FACTORY_STATE="+state,
		"FACTORY_WORKSPACE_MODE=isolated")
	if name == "up.sh" {
		env = append(env, "FACTORY_REQUIRE_NEW_SANDBOX=1", "FACTORY_BOOTSTRAP_WORKSPACE_ENV="+req.EarlyFile)
	}
	return host.RunProcess(ctx, host.Process{
		Path: "bash", Args: []string{"--noprofile", "--norc", script, req.Task},
		Dir: invocation.Directory, Env: env, Files: invocation.Files,
		Timeout: invocation.Timeout, Limit: hookOutputLimit, Owned: invocation.Owned,
	})
}

// readStandDescriptor проверяет жизненный цикл именно этой задачи.
// Дескриптор не исполняется как shell и не открывается через ссылку.
func readStandDescriptor(path, task string) ([]byte, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > hookOutputLimit {
		return nil, fmt.Errorf("стенд: недопустимый файл проекции готовности")
	}
	data, err := io.ReadAll(io.LimitReader(file, hookOutputLimit+1))
	if err != nil || len(data) > hookOutputLimit {
		return nil, fmt.Errorf("стенд: не удалось прочитать проекцию готовности")
	}
	fields := make(map[string]string)
	for row := range strings.SplitSeq(strings.TrimSuffix(string(data), "\n"), "\n") {
		key, value, found := strings.Cut(row, "=")
		if _, duplicate := fields[key]; !found || duplicate || key == "" {
			return nil, fmt.Errorf("стенд: неверная строка проекции готовности")
		}
		fields[key] = value
	}
	if fields["TASK"] != task || fields["WORKSPACE_MODE"] != "isolated" ||
		fields["STAND_OWNERSHIP"] != "task" {
		return nil, fmt.Errorf("стенд: проекция готовности не принадлежит задаче %s", task)
	}
	return data, nil
}

// standHealth вызывает только read-oriented проверку выбранного профиля.
// Умерший task-owned стенд восстанавливается сервером перед resume.
func standHealth(ctx context.Context, req StandRequest) (int, error) {
	invocation := req.Invocation
	if req.StateFile != "" {
		state := filepath.Dir(req.StateFile)
		invocation.Env = append(hookEnvironment(invocation.Env), "STATE_DIR="+state, "FACTORY_STATE="+state)
	}
	result := runBridge(ctx, invocation, "health", req.Task)
	if err := hookFailure("проверка стенда", result); err != nil {
		return result.RC, err
	}
	return 0, nil
}

// CleanupStand закрывает изолированный ресурс подтверждённой задачи.
// Shared checkout и его аренда остаются у текущей попытки.
func CleanupStand(ctx context.Context, req StandRequest) (int, error) {
	if req.Mode != "isolated" || req.Owner != "task" || !commandTask.MatchString(req.Task) {
		return 75, fmt.Errorf("стенд: очистка разрешена только владельцу isolated")
	}
	if _, err := readStandDescriptor(req.StateFile, req.Task); err != nil {
		return 78, err
	}
	result := runStandScript(ctx, req, "down.sh")
	return result.RC, hookFailure("down.sh", result)
}
