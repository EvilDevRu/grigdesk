package engine

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

// prepareWorkspace проверяет durable lease и полное рабочее дерево.
// Shared стенд никогда не поднимается из фабрики, isolated использует hook профиля.
func (e *execution) prepareWorkspace(ctx context.Context) (int, error) {
	w, r := e.workspace, e.request
	owner := "task"
	if w.Mode == "shared" {
		owner = "external"
		if err := r.Store.SharedLease(e.attempt, w.Resources, "require"); err != nil {
			return 73, err
		}
		if rc, err := e.sharedDescriptor(); err != nil {
			return rc, err
		}
	}
	early := filepath.Join(filepath.Dir(e.artifacts.ticket), "workspace-ready.env")
	request := hooks.StandRequest{
		Invocation: e.invoke, Task: r.Task, Mode: w.Mode, Owner: owner, StateFile: e.standFile(),
		EarlyFile: early, Resume: r.Mode != "start",
	}
	var scoutCode int
	if w.Mode == "isolated" && !request.Resume && !r.Hold && e.bundle.Machine["bootstrap"] != "skip" {
		request.EarlyReady = func(raw []byte) error {
			var err error
			scoutCode, err = e.runEarlyScout(ctx, raw)
			return err
		}
	}
	rc, err := hooks.PrepareStand(ctx, request)
	if err != nil {
		if scoutCode != 0 && rc != 75 {
			return scoutCode, err
		}
		return rc, err
	}
	raw, err := readLaunchInput(e.standFile(), 64*1024)
	if err != nil {
		return 78, err
	}
	fields, err := parseDescriptor(raw)
	if err != nil {
		return 78, err
	}
	if err := e.checkDescriptor(fields, owner); err != nil {
		return 78, err
	}
	if rc, err := e.prepareCheckout(ctx, fields); err != nil {
		return rc, err
	}
	return projectResult(e.project(
		state.ProjectionField{Key: "FE_PORT", Value: fields["FE_PORT"]},
		state.ProjectionField{Key: "API_PORT", Value: fields["API_PORT"]},
		state.ProjectionField{Key: "SB_K", Value: fields["SB_K"]},
		state.ProjectionField{Key: "STAND_OWNERSHIP", Value: owner},
		state.ProjectionField{Key: "CONTAINER", Value: w.Container},
		state.ProjectionField{Key: "BOOTSTRAP_ENV_ERROR", Value: ""},
	))
}

// runEarlyScout открывает разведке готовые checkout до полной готовности стенда.
// Стенд ещё обязан подтвердить итоговый descriptor и health перед входом в маршрут.
func (e *execution) runEarlyScout(ctx context.Context, raw []byte) (int, error) {
	fields, err := parseDescriptor(raw)
	if err != nil {
		return 78, err
	}
	if err := e.checkDescriptor(fields, "task"); err != nil {
		return 78, err
	}
	if rc, err := e.prepareCheckout(ctx, fields); err != nil {
		return rc, err
	}
	rc, err := e.bootstrap(ctx)
	e.scoutEarly, e.scoutWaiting = rc == 0 || rc == 22, rc == 22
	if e.scoutWaiting {
		return 0, nil
	}
	return rc, err
}

// prepareCheckout сверяет рабочие деревья для раннего и окончательного descriptor.
// Успех назначает физический cwd для контекста и запуска выбранного узла.
func (e *execution) prepareCheckout(ctx context.Context, fields map[string]string) (int, error) {
	for _, repo := range e.workspace.Repositories {
		path, err := filepath.EvalSymlinks(repo.Worktree)
		if err != nil || path != repo.Worktree {
			return 78, fmt.Errorf("checkout %s отсутствует или содержит ссылку", repo.Name)
		}
		top, err := e.git(ctx, repo.Worktree, "rev-parse", "--show-toplevel")
		if err != nil || strings.TrimSpace(string(top)) != repo.Worktree {
			return 78, fmt.Errorf("checkout %s не принадлежит закреплённому репозиторию", repo.Name)
		}
		branch, err := e.git(ctx, repo.Worktree, "symbolic-ref", "--quiet", "--short", "HEAD")
		if err != nil || strings.TrimSpace(string(branch)) != repo.Branch {
			return 75, fmt.Errorf("checkout %s не на закреплённой ветке", repo.Name)
		}
	}
	e.workspace.FrontPort, e.workspace.APIPort = fields["FE_PORT"], fields["API_PORT"]
	e.invoke.Directory = e.workspace.Repositories[0].Worktree
	return 0, nil
}

func (e execution) sharedDescriptor() (int, error) {
	path := e.standFile()
	raw, err := readLaunchInput(path, 64*1024)
	if err == nil {
		if !bytes.Equal(raw, e.sharedDescriptorBytes()) {
			return 75, fmt.Errorf("состояние shared-стенда расходится с закреплением")
		}
		return 0, nil
	}
	if _, statErr := os.Lstat(path); !os.IsNotExist(statErr) {
		return 78, err
	}
	if e.request.Mode != "start" {
		return 73, fmt.Errorf("на resume отсутствует готовый shared-стенд")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return 78, err
	}
	defer file.Close()
	if _, err := file.Write(e.sharedDescriptorBytes()); err != nil {
		return 78, err
	}
	return projectResult(file.Sync())
}

func (e execution) sharedDescriptorBytes() []byte {
	w := e.workspace
	var out strings.Builder
	fmt.Fprintf(&out, "TASK=%s\nPROTOCOL=route-v2\nWORKSPACE_MODE=shared\n", e.attempt.Task)
	fmt.Fprintf(&out, "STAND_OWNERSHIP=external\nCONTAINER=%s\nSERVICE_HOST=%s\n", w.Container, w.Host)
	fmt.Fprintf(&out, "SB_K=0\nAPI_PORT=%s\nFE_PORT=%s\nSOURCE_BRANCH=%s\n",
		w.APIPort, w.FrontPort, w.Repositories[0].Branch)
	fmt.Fprintf(&out, "REPO_COUNT=%d\n", len(w.Repositories))
	for i, repo := range w.Repositories {
		fmt.Fprintf(&out, "REPO_%d_NAME=%s\nREPO_%d_SOURCE=%s\nREPO_%d_WT=%s\nREPO_%d_BRANCH=%s\n",
			i, repo.Name, i, repo.Source, i, repo.Worktree, i, repo.Branch)
	}
	return []byte(out.String())
}

func (e execution) checkDescriptor(fields map[string]string, owner string) error {
	w := e.workspace
	_, err := strconv.ParseUint(fields["SB_K"], 10, 64)
	if err != nil || fields["TASK"] != e.attempt.Task || fields["WORKSPACE_MODE"] != w.Mode ||
		fields["STAND_OWNERSHIP"] != owner || fields["SOURCE_BRANCH"] != w.Repositories[0].Branch ||
		fields["REPO_COUNT"] != strconv.Itoa(len(w.Repositories)) {
		return fmt.Errorf("готовая среда расходится с закреплённым профилем")
	}
	for i, repo := range w.Repositories {
		prefix := fmt.Sprintf("REPO_%d_", i)
		if fields[prefix+"NAME"] != repo.Name || fields[prefix+"SOURCE"] != repo.Source ||
			fields[prefix+"WT"] != repo.Worktree || fields[prefix+"BRANCH"] != repo.Branch {
			return fmt.Errorf("готовая среда подменила репозиторий %s", repo.Name)
		}
	}
	for _, key := range []string{"FE_PORT", "API_PORT"} {
		value, present := fields[key]
		port, err := strconv.ParseUint(value, 10, 16)
		if !present || (w.Stand == "none" && value != "") ||
			(w.Stand != "none" && (err != nil || port < 1000)) {
			return fmt.Errorf("готовая среда вернула неверный порт %s", key)
		}
	}
	return nil
}

func parseDescriptor(raw []byte) (map[string]string, error) {
	fields := make(map[string]string)
	for line := range strings.SplitSeq(strings.TrimSuffix(string(raw), "\n"), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if _, exists := fields[key]; !ok || exists || key == "" || strings.ContainsRune(value, 0) {
			return nil, fmt.Errorf("неверный descriptor готовности")
		}
		fields[key] = value
	}
	return fields, nil
}

func (e execution) git(ctx context.Context, directory string, args ...string) ([]byte, error) {
	result := host.RunProcess(ctx, host.Process{
		Path: "git", Dir: directory, Args: append([]string{"-c", "diff.autoRefreshIndex=false"}, args...),
		Limit: 64 * 1024 * 1024,
		Env:   e.gitEnvironment(),
	})
	if result.RC != 0 || result.OutputOverflow {
		return nil, fmt.Errorf("не удалось проверить Git checkout (код %d)", result.RC)
	}
	return result.Stdout, nil
}

func (e execution) gitEnvironment() []string {
	return append(append([]string(nil), e.invoke.Env...), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
}
