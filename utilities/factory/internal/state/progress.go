package state

import "fmt"

// ValidateRunProgress сохраняет прежнюю таблицу ключей, значений и размер batch.
// Терминальный stage и поля человеческого решения запрещены.
func ValidateRunProgress(stage string, updates []ProjectionField) error {
	if len(updates) < 1 || len(updates) > 64 {
		return fmt.Errorf("stage-progress: нужно от 1 до 64 пар")
	}
	for _, update := range updates {
		if update.Key == stage {
			return fmt.Errorf("stage-progress: статус текущего узла требует stage-result")
		}
		switch update.Key {
		case "SIZE":
			if update.Value != "S" && update.Value != "M" && update.Value != "L" {
				return fmt.Errorf("stage-progress: SIZE принимает S, M или L")
			}
		case "PLANS", "SKEPTIC", "VALIDATE", "TRANSLATOR":
			if update.Value != "running" && update.Value != "done" && update.Value != "skipped" {
				return fmt.Errorf("stage-progress: недопустимый статус прогресса")
			}
		default:
			return fmt.Errorf("stage-progress: ключ не поддерживается")
		}
	}
	return nil
}

// ApplyRunProgress меняет разрешённые поля проекции действующего запуска.
// Право и terminal состояние берутся из control записи под lock.
func (s Store) ApplyRunProgress(id RunIdentity, token string, updates []ProjectionField) (int, error) {
	if err := ValidateRunProgress(id.Stage, updates); err != nil {
		return 2, err
	}
	handle, rc, err := s.openRun(id, true)
	if err != nil {
		return rc, err
	}
	defer handle.close()
	run, _, rc, err := handle.authorize(id, token)
	if err != nil {
		return rc, err
	}
	if run.State != "active" {
		return 75, fmt.Errorf("stage-progress: запуск уже завершён")
	}
	if err := handle.project.write(updates); err != nil {
		return 78, err
	}
	return 0, nil
}
