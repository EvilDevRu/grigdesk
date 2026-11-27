package runner

import (
	"errors"
	"os"
	"path/filepath"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

// beginEpoch создаёт state capability и физический отдельный каталог новой попытки.
// Предыдущие run artifacts сохраняются для метрик и ручного разбора.
func beginEpoch(
	base Run, task, attempt, stage, role string, admission ...state.StageSelectionAdmission,
) (Run, *AdapterError) {
	var id state.RunIdentity
	var token string
	var rc int
	var err error
	if len(admission) == 0 {
		id, token, rc, err = base.Store.NextRun(task, attempt, base.Node, stage, role)
	} else {
		id, token, rc, err = base.Store.NextRunWithSelection(task, attempt, base.Node, stage, role, admission[0])
	}
	if errors.Is(err, state.ErrConflict) {
		return base, &AdapterError{
			Code: 75, Marker: preflightFailureMarker(1, nil, nil), Detail: "settings_conflict", Err: state.ErrConflict,
		}
	}
	if rc != 0 || err != nil {
		return base, adapterError(rc, err.Error())
	}
	base.Identity, base.Capability = id, token
	base.Dir = filepath.Dir(base.Store.StatusRequestDir(id))
	if err := os.MkdirAll(filepath.Dir(base.Dir), 0700); err != nil {
		return base, adapterError(78, err.Error())
	}
	physical, err := filepath.EvalSymlinks(filepath.Dir(base.Dir))
	if err != nil || physical != filepath.Dir(base.Dir) {
		return base, adapterError(78, "недоверенный родитель run")
	}
	if err := os.Mkdir(base.Dir, 0700); err != nil {
		return base, adapterError(78, err.Error())
	}
	return base, nil
}
