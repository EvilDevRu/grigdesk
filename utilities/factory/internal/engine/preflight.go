package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/route"
	"grigdesk.local/tools/utilities/factory/internal/runner"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

// admitRunners ждёт результат metadata до изменения реестра и выдачи прав на модель.
// Признак несовместимости попадает в журнал только из этой части запуска.
func (e *execution) admitRunners(ctx context.Context) (int, error) {
	if err := ctx.Err(); err != nil {
		return 130, err
	}
	stages, primary, err := e.preflightScope(ctx)
	if err != nil {
		return 78, err
	}
	if len(stages) == 0 {
		return 0, nil
	}
	input, err := e.runnerAdmission(primary)
	if err != nil {
		return 78, fmt.Errorf("[FACTORY_ERROR=runner_preflight_failed]: %w", err)
	}
	preflight, err := e.runnerStageSelections(stages)
	if err != nil {
		return 78, err
	}
	ready, err := runner.Preflight(ctx, input, preflight)
	if ctx.Err() != nil {
		return 130, ctx.Err()
	}
	if err != nil {
		writeRouteLog(e.request, err.Error())
		if strings.HasPrefix(err.Error(), "[FACTORY_ERROR=runner_preflight_failed]") {
			return 78, err
		}
		return 1, err
	}
	e.runnerConfig, e.runnerReady = input.Config, ready
	return 0, nil
}

// runnerStageSelections принимает сохранённые параметры до проверки доступности.
// Оба шага используют один снимок для точного узла, даже если run key повторяется.
func (e *execution) runnerStageSelections(stages []route.AgentStage) ([]runner.StageAdmission, error) {
	e.runnerSelections = make(map[string]state.StageRunnerSelection)
	preflight := make([]runner.StageAdmission, 0, len(stages))
	for _, stage := range stages {
		var selected state.StageRunnerSelection
		if e.request.Mode != "start" {
			var err error
			selected, err = e.request.Store.ReadStageRunnerSelection(e.attempt, stage.Node, stage.Key)
			if err != nil {
				return nil, err
			}
		}
		e.runnerSelections[stage.Node] = selected
		preflight = append(preflight, runner.StageAdmission{Key: stage.Key, Selection: selected})
	}
	return preflight, nil
}

// preflightScope опирается на pinned курсор возобновляемой попытки.
// Открытая квитанция восстанавливается в рамках того же lock до расчёта достижимости.
func (e execution) preflightScope(ctx context.Context) ([]route.AgentStage, string, error) {
	scoutStage := route.AgentStage{Node: "scout", Key: "SCOUT"}
	scout := e.bundle.Machine["bootstrap"] != "skip"
	if e.request.Mode == "start" {
		stages := e.bundle.AgentStages("")
		if scout {
			stages = append(stages, scoutStage)
		}
		return stages, e.request.Runner, nil
	}
	store, a := e.request.Store, e.attempt
	cursor, err := store.ReadStage(a.Task, a.ID)
	var stages []route.AgentStage
	if errors.Is(err, state.ErrStageAbsent) {
		stages = e.bundle.AgentStages("")
	} else {
		if err != nil && !errors.Is(err, state.ErrStagePending) {
			return nil, "", err
		}
		cursor, _, err = e.replay(ctx, "")
		if err != nil {
			return nil, "", err
		}
		if cursor.State != "stopped" {
			stages = e.bundle.AgentStages(cursor.CurrentNode)
		}
	}
	if scout {
		raw, _, err := store.AttemptArtifact(a, "bootstrap.json", nil, false)
		switch {
		case os.IsNotExist(err):
			stages = append(stages, scoutStage)
		case err != nil:
			return nil, "", err
		default:
			if err := e.checkScout(raw); err != nil {
				return nil, "", err
			}
		}
	}
	return stages, a.RunnerPrimaryOverride, nil
}
