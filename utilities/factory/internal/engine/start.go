package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/route"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

type LaunchRequest struct {
	Store                                                  state.Store
	Mode, Task, Profile, Attempt, Route, RoutesDir         string
	ExpectedCatalog, Ticket, Dispatch, Runner, ProfileFile string
	Diagnosis, Signal                                      string
	Scope, Targets                                         []string
	Hold, TaskComment                                      bool
	Environment                                            []string
	Runtime                                                state.BindRuntime
	Log                                                    io.Writer
}

type execution struct {
	request          LaunchRequest
	attempt          state.Attempt
	bundle           route.MachineBundle
	workspace        hooks.Workspace
	invoke           hooks.Invocation
	artifacts        contractPaths
	catalog          string
	runnerConfig     map[string]string
	runnerReady      map[string]bool
	runnerSelections map[string]state.StageRunnerSelection
	scoutEarly       bool
	scoutWaiting     bool
	instrumentation  transactionView
}

// Launch занимает совместимый lock оркестратора до любых эффектов проекта.
// Held start подтверждает только подготовку, resume читает неизменяемые pins.
func Launch(ctx context.Context, request LaunchRequest) (code int, failure error) {
	lock, rc, err := request.Store.LockOrchestrator(request.Task)
	if err != nil {
		return rc, err
	}
	defer lock.Close()
	e := execution{request: request}
	if err := e.initializeInvocation(); err != nil {
		return 78, err
	}
	if rc, err := e.admit(ctx); err != nil {
		return rc, err
	}
	if request.Mode != "start" && !request.Hold && e.bundle.Machine["bootstrap"] != "skip" {
		waiting, err := request.Store.BootstrapWaiting(e.attempt)
		if err != nil {
			return 78, err
		}
		if waiting {
			return projectResult(e.projectScoutPause())
		}
	}
	if rc, err := e.admitRunners(ctx); err != nil {
		return rc, err
	}
	if request.Mode == "start" {
		if rc, err := e.begin(e.catalog); err != nil {
			return rc, err
		}
	}
	defer func() {
		fields := []state.ProjectionField{{Key: "ORCH_PID", Value: ""}}
		if code == 130 && errors.Is(failure, context.Canceled) {
			fields = append(fields, state.ProjectionField{Key: "STOPPED_SIGNAL", Value: "1"})
		}
		if err := e.project(fields...); err != nil {
			code, failure = 78, errors.Join(failure, err)
		}
	}()
	if rc, err := e.prepare(ctx); err != nil {
		if rc == 130 && errors.Is(ctx.Err(), context.Canceled) {
			return 130, ctx.Err()
		}
		return rc, errors.Join(err, e.projectPrepareFailure(rc))
	}
	if request.Hold {
		return projectResult(e.project(state.ProjectionField{Key: "HELD_START", Value: "1"}))
	}
	if err := e.resumeTransaction(ctx); err != nil {
		mark := e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"})
		return 75, errors.Join(err, mark)
	}
	if e.scoutWaiting {
		return projectResult(e.projectScoutPause())
	}
	if !e.scoutEarly {
		if rc, err := e.bootstrap(ctx); err != nil {
			if rc == 22 {
				return projectResult(e.projectScoutPause())
			}
			return rc, err
		}
	}
	snapshot, rc, err := e.stageForLaunch(ctx)
	if err != nil {
		return rc, err
	}
	snapshot, rc, err = e.continueLoop(snapshot)
	if err != nil {
		return rc, err
	}
	return e.dispatch(ctx, snapshot)
}

// projectPrepareFailure сохраняет вопрос разведки при отказе параллельного up.sh.
// Степень готовности среды показывается отдельным полем карточки.
func (e execution) projectPrepareFailure(code int) error {
	fields := []state.ProjectionField{{Key: "STALLED_HUMAN", Value: "1"}}
	if e.scoutEarly {
		fields = append(fields, state.ProjectionField{Key: "BOOTSTRAP_ENV_ERROR",
			Value: fmt.Sprintf("среда не готова (код %d)", code)})
	}
	if e.scoutWaiting {
		fields = append(fields, state.ProjectionField{Key: "RESULT", Value: "stopped-bootstrap-human"})
	}
	return e.project(fields...)
}

// initializeInvocation даёт хукам только явно назначенные корни текущей установки.
// Сам профиль исполняется отдельным фиксированным входом Bash bridge.
func (e *execution) initializeInvocation() error {
	r := e.request
	if err := os.MkdirAll(r.Store.StateDir, 0700); err != nil {
		return err
	}
	env := append(append([]string(nil), r.Environment...),
		"FACTORY_STATE="+r.Store.StateDir, "STATE_DIR="+r.Store.StateDir, "PROFILE="+r.Profile)
	e.invoke = hooks.Invocation{
		Profile: r.ProfileFile, Directory: r.Store.StateDir, Env: env, Timeout: 10 * time.Minute, Owned: true,
	}
	return nil
}

// admit открывает точный пин для повторного захода и подтверждает query каталога
// для нового запуска до профильного shell и lease.
func (e *execution) admit(ctx context.Context) (int, error) {
	r := e.request
	reader, err := route.NewBundleReader(r.RoutesDir, r.Profile)
	if err != nil {
		return 78, err
	}
	var catalog route.CatalogBundle
	if r.Mode == "start" {
		catalog, err = reader.ReadCurrent()
		if err == nil && r.ExpectedCatalog != "" && r.ExpectedCatalog != catalog.Hash {
			return 75, fmt.Errorf("FACTORY_ERROR=catalog_changed EXPECTED=%s ACTUAL=%s",
				r.ExpectedCatalog, catalog.Hash)
		}
		if err != nil {
			return 78, err
		}
		if catalog.Routes[r.Route] == "" {
			return 78, fmt.Errorf("выбранный маршрут отсутствует в каталоге")
		}
		e.bundle, err = reader.ReadRoute(r.Route, catalog.Routes[r.Route])
	} else {
		e.attempt, err = r.Store.ReadAttempt(r.Task, r.Attempt)
		if err == nil {
			if e.attempt.Profile != r.Profile || e.attempt.RoutesDir != r.RoutesDir ||
				(e.attempt.RouteID != r.Route && r.Route != "") || e.attempt.Terminal != "" {
				return 75, fmt.Errorf("активная попытка не совпадает с resume")
			}
			e.bundle, err = reader.ReadRoute(e.attempt.RouteID, e.attempt.RouteHash)
		}
	}
	if err != nil {
		return 78, err
	}
	workspace, rc, err := hooks.ReadWorkspace(ctx, e.invoke, r.Task)
	if err != nil {
		return rc, err
	}
	e.workspace = workspace
	if _, err := e.loopLimit(); err != nil {
		return 78, err
	}
	e.catalog = catalog.Hash
	return 0, nil
}

func (e *execution) begin(expected string) (int, error) {
	r := e.request
	if e.workspace.Mode == "shared" {
		pending := state.Attempt{Task: r.Task, Profile: r.Profile, ID: "pending"}
		if err := r.Store.SharedLease(pending, e.workspace.Resources, "reserve"); err != nil {
			return 73, err
		}
	}
	attempt, rc, err := r.Store.BeginAttempt(state.BeginInput{
		Task: r.Task, Profile: r.Profile, RoutesDir: r.RoutesDir, ExpectedCatalogHash: expected,
		QueueDispatchID: r.Dispatch, RunnerPrimaryOverride: r.Runner, Runtime: r.Runtime,
	})
	if err != nil {
		return rc, err
	}
	if e.workspace.Mode == "shared" {
		if err := r.Store.SharedLease(attempt, e.workspace.Resources, "bind"); err != nil {
			return 75, err
		}
	}
	e.attempt, err = r.Store.SelectRoute(r.Task, attempt.ID, r.Route)
	if err != nil {
		return 78, err
	}
	return projectResult(r.Store.InitLifecycle(e.attempt.Task, e.attempt.ID))
}

func (e *execution) prepare(ctx context.Context) (int, error) {
	r, w := e.request, e.workspace
	delivery, instrumentation := e.bundle.LaunchTopology()
	hold := "0"
	if r.Hold {
		hold = "pending"
	}
	fields := []state.ProjectionField{
		{Key: "ORCH_PID", Value: strconv.Itoa(os.Getpid())}, {Key: "STALLED_HUMAN", Value: "0"},
		{Key: "STOPPED_SIGNAL", Value: "0"}, {Key: "HELD_START", Value: hold},
		{Key: "CATALOG_HASH", Value: e.attempt.CatalogHash}, {Key: "ROUTE_HASH", Value: e.attempt.RouteHash},
		{Key: "QUEUE_DISPATCH_ID", Value: e.attempt.QueueDispatchID},
		{Key: "RUNNER_OVERRIDE_PRIMARY", Value: e.attempt.RunnerPrimaryOverride},
		{Key: "WORKSPACE_MODE", Value: w.Mode}, {Key: "DELIVERY_MODE", Value: delivery},
		{Key: "INSTRUMENTATION_MODE", Value: instrumentation},
	}
	if r.Mode == "start" {
		fields = append(fields, state.ProjectionField{Key: "RESULT", Value: ""})
	}
	if err := e.project(fields...); err != nil {
		return 78, err
	}
	if rc, err := e.pinContracts(delivery, instrumentation); err != nil {
		return rc, err
	}
	return e.prepareWorkspace(ctx)
}

func (e execution) project(fields ...state.ProjectionField) error {
	return e.request.Store.UpdateProjection(e.attempt.Task, e.attempt.ID, fields)
}

func projectResult(err error) (int, error) {
	if errors.Is(err, state.ErrConflict) {
		return 75, err
	}
	if err != nil {
		return 78, err
	}
	return 0, nil
}

func (e execution) standFile() string {
	return filepath.Join(e.request.Store.StateDir, "t"+e.attempt.Task+".env")
}
