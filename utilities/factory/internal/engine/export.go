package engine

import "grigdesk.local/tools/utilities/factory/internal/state"

// ExportFindings проверяет bootstrap тем же валидатором, что использует resume.
// Выгрузка не меняет курсор и доступна после закрытия попытки.
func ExportFindings(input LaunchRequest) (state.FindingsReport, error) {
	report, attempt, checkpoint, err := input.Store.ReadFindings(
		input.Task, input.Attempt, input.Profile, input.RoutesDir,
	)
	if err != nil || len(checkpoint) == 0 {
		return report, err
	}
	e := execution{request: input, attempt: attempt}
	if err := e.checkScout(checkpoint); err != nil {
		return report, err
	}
	return report, report.AppendBootstrapFindings(checkpoint)
}
