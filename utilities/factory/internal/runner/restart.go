package runner

import (
	"context"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

// watchRestart отменяет только локальный контекст владельца исходной эпохи.
// Новое дерево запускается лишь после проверки выхода старого в host.RunProcess.
func (run Run) watchRestart(parent context.Context) (context.Context, func()) {
	if run.Identity.Node == "" {
		return parent, func() {}
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				restart, err := run.Store.PendingStageRunnerRestart(run.Identity)
				if err == nil && restart != nil {
					if run.recordRestart(*restart) == nil {
						cancel()
					}
					return
				}
			}
		}
	}()
	return ctx, func() {
		cancel()
		<-done
	}
}

// recordRestart подтверждает запись намерения раньше отмены дерева.
// Ошибка сохраняет понятный receipt и оставляет выбранный запуск под обычным контролем.
func (run Run) recordRestart(restart state.StageRunnerRestart) error {
	if run.RecordRestart == nil {
		return nil
	}
	if err := run.RecordRestart(run.Identity, restart, false); err != nil {
		_ = run.Store.AdvanceStageRunnerRestart(run.Identity, restart, "failed", "Журнал не подтвердил запрос.")
		return err
	}
	return nil
}
