package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/route"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

// recoverAttempt начинает новую попытку с прежними immutable inputs.
// Продолжение или новый bootstrap остаются отдельным resume.
func recoverAttempt(ctx context.Context, input DecisionRequest, previous state.Attempt) (int, error) {
	if previous.Terminal != "abandoned" {
		return 75, fmt.Errorf("восстановление требует abandoned attempt")
	}
	e := execution{request: input.LaunchRequest, attempt: previous}
	if rc, err := e.checkNoActiveTransaction(); err != nil {
		return rc, err
	}
	if err := e.initializeInvocation(); err != nil {
		return 78, err
	}
	workspace, rc, err := hooks.ReadWorkspace(ctx, e.invoke, input.Task)
	if err != nil {
		return rc, err
	}
	reader, err := route.NewBundleReader(input.RoutesDir, input.Profile)
	if err != nil {
		return 78, err
	}
	catalog, err := reader.ReadCurrent()
	if err != nil || catalog.Routes[input.Route] == "" {
		return 78, fmt.Errorf("маршрут восстановления недоступен в текущем каталоге")
	}
	if workspace.Mode == "shared" {
		pending := state.Attempt{Task: input.Task, Profile: input.Profile, ID: "pending"}
		if err := input.Store.SharedLease(pending, workspace.Resources, "reserve"); err != nil {
			return 73, err
		}
	}
	created, rc, err := input.Store.BeginAttempt(state.BeginInput{
		Task: input.Task, Profile: input.Profile, RoutesDir: input.RoutesDir,
		ExpectedCatalogHash: catalog.Hash,
		Previous:            previous.ID, RecoveryReason: input.Reason, Runtime: input.Runtime,
	})
	if err != nil {
		return rc, err
	}
	if workspace.Mode == "shared" {
		if err := input.Store.SharedLease(created, workspace.Resources, "bind"); err != nil {
			return 75, err
		}
	}
	e.attempt, err = input.Store.SelectRoute(input.Task, created.ID, input.Route)
	if err != nil {
		return projectResult(err)
	}
	if err := input.Store.InitLifecycle(input.Task, created.ID); err != nil {
		return projectResult(err)
	}
	if err := e.projectRecovery(); err != nil {
		return projectResult(err)
	}
	_, err = fmt.Fprintln(input.Output, "recovered", created.ID)
	return projectResult(err)
}

func (e execution) projectRecovery() error {
	fields := []state.ProjectionField{
		{Key: "RESULT", Value: "recovered"}, {Key: "STALLED_HUMAN", Value: "0"},
		{Key: "STOPPED_SIGNAL", Value: "0"}, {Key: "HELD_START", Value: "0"},
		{Key: "CATALOG_HASH", Value: e.attempt.CatalogHash}, {Key: "ROUTE_HASH", Value: e.attempt.RouteHash},
		{Key: "QUEUE_DISPATCH_ID", Value: ""}, {Key: "ORCH_PID", Value: ""},
		{Key: "RUNNER_OVERRIDE_PRIMARY", Value: e.attempt.RunnerPrimaryOverride},
	}
	return e.project(fields...)
}

func (e execution) checkNoActiveTransaction() (int, error) {
	path := filepath.Join(e.request.Store.ControlDir, "transactions", "t"+e.attempt.Task, "active.env")
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		return 75, fmt.Errorf("сначала нужна проверка и очистка открытой транзакции инструментации")
	}
	return 0, nil
}

// stageForLaunch открывает cursor только после узкой writable проверки receipt.
// Отсутствующий cursor удержанной попытки создаётся после проверки bootstrap.
func (e execution) stageForLaunch(ctx context.Context) (state.StageSnapshot, int, error) {
	store, a := e.request.Store, e.attempt
	cursor, err := store.ReadStage(a.Task, a.ID)
	if errors.Is(err, state.ErrStageAbsent) {
		cursor, err = store.InitStage(a.Task, a.ID)
		rc, err := projectResult(err)
		return cursor, rc, err
	}
	if err != nil && !errors.Is(err, state.ErrStagePending) {
		return cursor, 78, err
	}
	if e.request.Mode == "resume" {
		return e.replay(ctx, "")
	}
	return cursor, 0, nil
}

// replay повторяет только недолговечный I/O, сохраняя отдельные последствия CAS и integrity.
// Подтверждённый event приводит к replay проекции без нового command.
func (e execution) replay(ctx context.Context, tree string) (state.StageSnapshot, int, error) {
	s := e.request.Store
	a := e.attempt
	var cursor state.StageSnapshot
	var status string
	var rc int
	var err error
	for tries := 0; tries < 3; tries++ {
		if err := ctx.Err(); err != nil {
			return cursor, 130, err
		}
		cursor, status, rc, err = s.ReplayPending(a.Task, a.ID, tree)
		if rc != 1 && rc != 74 {
			break
		}
	}
	if err != nil {
		return cursor, rc, err
	}
	switch status {
	case "needs-tree":
		path, err := e.guardFile(ctx)
		if err != nil {
			return cursor, 78, err
		}
		defer os.Remove(path)
		return e.replay(ctx, path)
	case "committed":
		if err := e.projectCommitted(cursor); err != nil {
			code, err := projectResult(err)
			return cursor, code, err
		}
	case "stale":
		if e.request.Log != nil {
			fmt.Fprintln(e.request.Log, "старый pending переход не использован: новый cursor или исходники")
		}
	}
	return cursor, 0, nil
}

func (e execution) guardFile(ctx context.Context) (string, error) {
	guard, err := e.snapshotWorkspace(ctx)
	if err != nil {
		return "", err
	}
	file, err := os.CreateTemp(e.request.Store.ControlDir, ".pending-guard-")
	if err != nil {
		return "", err
	}
	name := file.Name()
	_, writeErr := file.Write(guard)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		os.Remove(name)
		return "", err
	}
	return name, nil
}

func (e execution) projectCommitted(cursor state.StageSnapshot) error {
	s, a := e.request.Store, e.attempt
	tail, err := s.ReadStageTail(a.Task, a.ID, cursor.HeadEventHash)
	if err != nil {
		return err
	}
	node, _ := tail.Data["node"].(string)
	outcome, _ := tail.Data["outcome"].(string)
	key, _ := e.findNode(node)["runKey"].(string)
	if key == "" || outcome == "" {
		return fmt.Errorf("pending transition: нет проекции узла")
	}
	fields := []state.ProjectionField{{Key: key, Value: outcome}}
	if cursor.State == "stopped" && cursor.Stop != "done" {
		fields = append(fields, state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"})
	}
	if err := e.project(fields...); err != nil {
		return err
	}
	return s.AckPending(a.Task, a.ID, cursor.HeadEventHash)
}
