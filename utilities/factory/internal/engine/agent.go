package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/route"
	"grigdesk.local/tools/utilities/factory/internal/runner"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

// runAgent использует policy закреплённого узла и принимает только terminal из state.
// Ошибка хоста и результат проверки продукта попадают в разные ветви диспетчера.
func (e execution) runAgent(
	ctx context.Context, cursor state.StageSnapshot, node map[string]any, key string,
) (state.StageSnapshot, int, error) {
	policy, _ := node["policy"].(map[string]any)
	filesystem, _ := policy["filesystem"].(string)
	if filesystem == "transactional-write" {
		return e.runTransactionAgent(ctx, cursor, node, key)
	}
	prompt, err := e.agentPrompt(cursor, key)
	if err != nil {
		return cursor, 78, err
	}
	request, err := e.runnerRequest(cursor, node, key, prompt)
	if err != nil {
		return cursor, 78, err
	}
	if filesystem == "state-only" {
		request.BeforeInvoke, request.AfterInvoke = e.workspaceGuard(ctx, nil)
	}
	visit, rc, err := e.beginAgentVisit(cursor, key)
	if err != nil {
		return cursor, rc, err
	}
	request.RecordRestart = e.restartLifecycle(visit)
	result, err := e.dispatchAgent(ctx, request)
	if errors.Is(err, context.Canceled) {
		return cursor, 130, err
	}
	if err != nil {
		return cursor, 75, err
	}
	return e.commitAgent(ctx, cursor, key, result, visit)
}

// dispatchAgent закрывает канал профиля до публикации результата визита.
// Один канал обслуживает повторы и смену провайдера внутри визита.
func (e execution) dispatchAgent(
	ctx context.Context, request runner.DispatchRequest,
) (runner.DispatchResult, error) {
	request.ReadAgentRules = func(ctx context.Context) ([]string, []string, error) {
		rules, err := hooks.ReadAgentRules(ctx, e.invoke, request.Stage)
		return rules.Allow, rules.Deny, err
	}
	if runtime.GOOS != "linux" {
		return runner.Dispatch(ctx, request)
	}
	control, err := hooks.OpenAgentControl(ctx, e.invoke, request.Task, request.Stage)
	if err != nil {
		return runner.DispatchResult{}, err
	}
	if control != nil {
		request.AgentControlDir = control.Directory
		if control.Codex {
			request.CodexShared = &runner.CodexSharedAccess{
				BrokerDir: control.Directory, ReadDirs: control.ReadDirs, WriteDirs: control.WriteDirs,
			}
		}
	}
	result, dispatchErr := runner.Dispatch(ctx, request)
	if control == nil {
		return result, dispatchErr
	}
	rc := result.RC
	if errors.Is(dispatchErr, context.Canceled) {
		rc = 130
	} else if rc == 0 && dispatchErr != nil {
		rc = 75
	}
	if err := control.Close(rc); err != nil {
		if dispatchErr != nil {
			return result, fmt.Errorf("%v: %w", dispatchErr, err)
		}
		return result, err
	}
	return result, dispatchErr
}

// agentPrompt рендерит закреплённый шаблон с функциями текущего визита.
// Временный контекст хранится в control только на время рендера.
func (e execution) agentPrompt(cursor state.StageSnapshot, key string) (string, error) {
	contextFile, err := e.commandContext(cursor, key)
	if err != nil {
		return "", err
	}
	defer os.Remove(contextFile)
	prompt, err := route.RenderBundleFile(e.bundle, cursor.CurrentNode, contextFile)
	if err == nil && prompt == "" {
		err = fmt.Errorf("не получен prompt закреплённого узла")
	}
	return prompt, err
}

func (e execution) runnerRequest(
	cursor state.StageSnapshot, node map[string]any, key, prompt string,
) (runner.DispatchRequest, error) {
	request, err := e.runnerAdmission(e.attempt.RunnerPrimaryOverride)
	if err != nil {
		return runner.DispatchRequest{}, err
	}
	policy, _ := node["policy"].(map[string]any)
	retry, _ := node["retry"].(map[string]any)
	filesystem, _ := policy["filesystem"].(string)
	max, _ := strconv.Atoi(fmt.Sprint(retry["noResult"]))
	role := e.loopRole(cursor.CurrentNode)
	request.Store, request.Task, request.Attempt = e.request.Store, e.attempt.Task, e.attempt.ID
	request.Node, request.Stage, request.Role, request.Prompt = cursor.CurrentNode, key, role, prompt
	request.Filesystem, request.Worktree = filesystem, e.invoke.Directory
	request.Timeout, request.NoResultRetries = 20*time.Minute, max
	request.Shared = e.workspace.Mode == "shared"
	request.Selection = e.runnerSelections[cursor.CurrentNode]
	request.ReadSelection = func() (state.StageRunnerSelection, error) {
		return e.request.Store.ReadStageRunnerSelection(e.attempt, cursor.CurrentNode, key)
	}
	browser, _ := policy["browser"].(string)
	request.Environment = append(append([]string{}, request.Environment...),
		"FACTORY_ROUTE_BROWSER_POLICY="+browser, "FACTORY_ROUTE_BROWSER_ROUTES_DIR="+e.attempt.RoutesDir)
	request.Ready = e.runnerReady
	return request, nil
}

// runnerAdmission использует те же данные для metadata probe и запуска.
// Settings читаются один раз на запрос и передаются следующим узлам этого запуска.
func (e execution) runnerAdmission(primary string) (runner.DispatchRequest, error) {
	config := e.runnerConfig
	if config == nil {
		path := filepath.Join(filepath.Dir(e.request.ProfileFile), "runners.env")
		var err error
		config, err = hooks.RunnerConfig(path)
		if err != nil {
			return runner.DispatchRequest{}, err
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return runner.DispatchRequest{}, err
	}
	home := runner.FactoryHome(e.request.Environment, executable)
	return runner.DispatchRequest{Factory: executable, FactoryHome: home, Primary: primary,
		Config: config, Environment: e.request.Environment}, nil
}

func (e execution) loopRole(node string) string {
	pair, _ := e.bundle.Machine["loop"].(map[string]any)
	for _, name := range []string{"lead", "worker"} {
		if pair[name] == node {
			return name
		}
	}
	return ""
}

func (e execution) commitAgent(
	ctx context.Context, cursor state.StageSnapshot, key string,
	result runner.DispatchResult, visit commandVisit,
) (state.StageSnapshot, int, error) {
	code, verdict := result.Terminal.Result, result.Terminal.Verdict
	if result.Classification == "exhausted" {
		code = "exhausted"
	}
	if code == "" {
		return cursor, 78, fmt.Errorf("терминал агента не принят")
	}
	guard, err := e.guardFile(ctx)
	if err != nil {
		return cursor, 78, err
	}
	defer os.Remove(guard)
	limit, err := e.loopLimit()
	if err != nil {
		return cursor, 78, err
	}
	comment := state.ProjectionField{Key: key + "_COMMENT", Value: result.Terminal.Comment}
	if err := e.project(comment); err != nil {
		return cursor, 78, err
	}
	a := e.attempt
	args := []string{
		a.Task, a.ID, cursor.CurrentNode, code, "0", verdict, "0", "0", "0", "", strconv.FormatInt(limit, 10),
	}
	if err := e.request.Store.PreparePending(state.PendingRequest{
		Task: a.Task, Attempt: a.ID, Tree: guard, ExpectedHead: cursor.HeadEventHash,
		Sequence: cursor.Sequence, Args: args, Origin: visit.origin(),
	}); err != nil {
		return cursor, 78, err
	}
	return e.replay(ctx, guard)
}

func environmentValue(env []string, name string) string {
	prefix := name + "="
	for i := len(env) - 1; i >= 0; i-- {
		if value, ok := strings.CutPrefix(env[i], prefix); ok {
			return value
		}
	}
	return ""
}

func (e execution) beginAgentVisit(cursor state.StageSnapshot, key string) (commandVisit, int, error) {
	a := e.attempt
	visit := commandVisit{node: cursor.CurrentNode, key: key, ordinal: cursor.Sequence}
	history, err := e.request.Store.ReadLifecycle(a.Task, a.ID)
	if err != nil {
		return visit, 78, err
	}
	pin := false
	prior := make(map[string]bool)
	for _, event := range history {
		row := event.Data
		if row["kind"] == "route_selected" {
			pin = true
		}
		id, _ := row["nodeVisitId"].(string)
		if row["kind"] == "node_visit_started" && row["nodeId"] == cursor.CurrentNode {
			details, _ := row["details"].(map[string]any)
			if details["stageEventHash"] == cursor.HeadEventHash {
				prior[id] = true
			}
		}
		if row["kind"] == "node_execution_started" && prior[id] {
			return visit, 75, fmt.Errorf("исход предыдущего запуска не подтверждён")
		}
	}
	id, err := host.CurrentIdentity()
	if err != nil {
		return visit, 78, err
	}
	visit.boot, visit.session, visit.visit = id.Boot, lifeID("os"), lifeID("nv")
	visit.visitSpan, visit.execution = lifeID("sp"), lifeID("ne")
	if !pin {
		if err := e.recordRouteSelected(visit); err != nil {
			return visit, 78, err
		}
	}
	if err := e.recordNodeVisit(visit, cursor); err != nil {
		return visit, 78, err
	}
	details := map[string]any{
		"executionReason": "initial", "retryOrdinal": 0, "retryBudgetBefore": 0, "executorKind": "agent",
	}
	if err := e.appendLife(visit, "node_execution_started", lifeID("sp"), details); err != nil {
		return visit, 78, err
	}
	return visit, 0, nil
}
