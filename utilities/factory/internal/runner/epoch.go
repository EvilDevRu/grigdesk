package runner

import (
	"os"
	"path/filepath"
)

// beginEpoch создаёт state capability и физический отдельный каталог новой попытки.
// Предыдущие run artifacts сохраняются для метрик и ручного разбора.
func beginEpoch(base Run, task, attempt, stage, role string) (Run, *AdapterError) {
	id, token, rc, err := base.Store.NextRun(task, attempt, base.Node, stage, role)
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
