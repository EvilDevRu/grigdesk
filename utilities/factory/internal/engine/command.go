package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/route"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

// runCommand вызывает только trusted profile ABI с настроенной политикой узла.
// Guard и валидированный результат должны предшествовать записи перехода.
func (e execution) runCommand(
	ctx context.Context, cursor state.StageSnapshot, node map[string]any, runKey string,
) (state.StageSnapshot, int, error) {
	policy, _ := node["policy"].(map[string]any)
	filesystem, _ := policy["filesystem"].(string)
	if filesystem != "state-only" && filesystem != "workspace-write" {
		return cursor, 78, fmt.Errorf("command: неподдерживаемый filesystem=%s", filesystem)
	}
	path, err := e.commandContext(cursor, runKey)
	if err != nil {
		return cursor, 78, err
	}
	defer os.Remove(path)
	var before []byte
	if filesystem == "state-only" {
		before, err = e.snapshotWorkspace(ctx)
		if err != nil {
			return cursor, 78, err
		}
	}
	if err := e.project(state.ProjectionField{Key: runKey, Value: "running"}); err != nil {
		return cursor, 78, err
	}
	command, _ := node["commandId"].(string)
	visit, rc, err := e.beginCommandVisit(cursor, runKey, command)
	if err != nil {
		return cursor, rc, err
	}
	verdict, rc, hookErr := hooks.RunCommand(ctx, e.invoke, hooks.CommandInput{
		Task: e.attempt.Task, Route: e.attempt.RouteID, Node: cursor.CurrentNode,
		RunKey: runKey, CommandID: command, ContextFile: path,
	})
	// Хост возвращает 130 только после подтверждённого завершения своего дерева.
	if rc == 130 && errors.Is(ctx.Err(), context.Canceled) {
		return cursor, rc, ctx.Err()
	}
	if filesystem == "state-only" {
		after, err := e.snapshotWorkspace(ctx)
		if err != nil {
			return cursor, 78, errors.Join(err, hookErr)
		}
		if !bytes.Equal(before, after) {
			return cursor, 75, fmt.Errorf("workspace guard: узел %s изменил checkout", cursor.CurrentNode)
		}
	}
	if hookErr != nil {
		if rc != 78 {
			rc = 75
		}
		return cursor, rc, hookErr
	}
	return e.commitCommand(ctx, cursor, runKey, verdict, visit)
}

// commitCommand использует тот же валидатор находок, что status writer агента.
// Проекция результата появляется после доверенного commit.
func (e execution) commitCommand(
	ctx context.Context, cursor state.StageSnapshot, key string,
	verdict hooks.CommandVerdict, visit commandVisit,
) (state.StageSnapshot, int, error) {
	typed, err := encodeCommandVerdict(verdict)
	if err != nil {
		return cursor, 78, err
	}
	if err := e.finishCommandVisit(visit, typed); err != nil {
		return cursor, 78, err
	}
	guard, err := e.guardFile(ctx)
	if err != nil {
		return cursor, 78, err
	}
	defer os.Remove(guard)
	err = e.project(state.ProjectionField{Key: key + "_COMMENT", Value: verdict.Comment})
	if err != nil {
		rc, err := projectResult(err)
		return cursor, rc, err
	}
	a := e.attempt
	args := []string{a.Task, a.ID, cursor.CurrentNode, verdict.Outcome, "0", typed, "0", "0", "0", "", "0"}
	if err := e.request.Store.PreparePending(state.PendingRequest{
		Task: a.Task, Attempt: a.ID, Tree: guard, ExpectedHead: cursor.HeadEventHash,
		Sequence: cursor.Sequence, Args: args, Origin: visit.origin(),
	}); err != nil {
		rc, err := projectResult(err)
		return cursor, rc, err
	}
	return e.replay(ctx, guard)
}

func encodeCommandVerdict(verdict hooks.CommandVerdict) (string, error) {
	input := make([]string, 0, len(verdict.Findings)+len(verdict.Reviewed))
	for _, finding := range verdict.Findings {
		raw := finding.ID + "=" + finding.Summary
		if finding.Severity == "deferred" {
			raw = "deferred:" + raw
		}
		input = append(input, raw)
		if finding.Anchor != "" {
			input = append(input, "anchor:"+finding.ID+"="+finding.Anchor)
		}
	}
	for _, item := range verdict.Reviewed {
		input = append(input, "reviewed:"+item)
	}
	return state.EncodeRunVerdict(verdict.Outcome, verdict.FailureOwner, input, false)
}

// commandContext строит typed context через общий порт редактора.
// Артефакт находится в control tree и выдаётся хуку на чтение.
func (e execution) commandContext(cursor state.StageSnapshot, key string) (string, error) {
	args, err := e.contextArgs(cursor, key, false)
	if err != nil {
		return "", err
	}
	file, err := os.CreateTemp(e.request.Store.ControlDir, ".command-context-")
	if err != nil {
		return "", err
	}
	var diagnostic bytes.Buffer
	rc := route.RunContext(args, file, &diagnostic)
	closeErr := errors.Join(file.Chmod(0400), file.Close())
	if rc != 0 || closeErr != nil {
		os.Remove(file.Name())
		return "", fmt.Errorf("контекст команды rc=%d %s %v", rc, diagnostic.String(), closeErr)
	}
	return file.Name(), nil
}

// contextArgs собирает общий контекст из pins и проверенных проекций.
// Отдельной разведке ещё недоступен журнал основного маршрута.
func (e execution) contextArgs(cursor state.StageSnapshot, key string, bootstrap bool) ([]string, error) {
	a, w := e.attempt, e.workspace
	delivery, _ := e.bundle.LaunchTopology()
	args := []string{
		"--task", a.Task, "--profile", a.Profile, "--attempt", a.ID, "--catalog-hash", a.CatalogHash,
		"--route", a.RouteID, "--route-hash", a.RouteHash, "--node", cursor.CurrentNode, "--run-key", key,
		"--ticket-json", e.artifacts.ticket,
		"--project-context-json", strings.TrimSuffix(string(w.Project), "\n"),
		"--state-dir", e.request.Store.StateDir, "--workspace-mode", w.Mode, "--container-name", w.Container,
		"--source-branch", w.Repositories[0].Branch, "--service-host", w.Host, "--delivery-mode", delivery,
	}
	for _, repo := range w.Repositories {
		args = append(args, "--repo", repo.Name+":"+repo.Worktree+":"+repo.Source+":"+repo.Branch)
	}
	if w.FrontPort != "" && w.APIPort != "" {
		args = append(args, "--frontend-port", w.FrontPort, "--api-port", w.APIPort)
	}
	if e.artifacts.diagnosis != "" {
		args = append(args, "--diagnosis-kind", e.artifacts.diagnosis,
			"--diagnosis-signal", e.artifacts.signal)
	}
	if e.artifacts.scope != "" {
		args = append(args, "--instrumentation-required")
	}
	if tx := e.instrumentation; tx.id != "" {
		args = append(args, "--transaction-id", tx.id, "--scope-file", tx.scope,
			"--instrumentation-phase", "active")
		for _, path := range tx.allowed {
			args = append(args, "--allowed-file", path.absolute())
		}
	}
	if e.artifacts.strategy != "" {
		args = append(args, "--delivery-strategy", e.artifacts.strategy)
	}
	for _, action := range e.artifacts.actions {
		args = append(args, "--delivery-action", action)
	}
	for _, target := range e.artifacts.targets {
		args = append(args, "--delivery-target", target)
	}
	if !bootstrap {
		results, err := e.request.Store.StageResults(a.Task, a.ID)
		if err != nil {
			return nil, err
		}
		for _, result := range results {
			args = append(args, "--stage-result", result)
		}
	}
	if filepath.Clean(e.request.Store.StateDir) != e.request.Store.StateDir {
		return nil, fmt.Errorf("контекст: неканонический state-dir")
	}
	return args, nil
}
