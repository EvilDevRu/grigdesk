package runner

import "slices"

// runGlmAdapter передаёт только выбранный api режим и проверенный descriptor.
// Неизвестные ошибки провайдера не подтверждают возможность повторного вызова.
func runGlmAdapter(
	run Run, node, supply, access string, policy routePolicy, prompt string,
) (Outcome, *AdapterError) {
	if access != "api" && access != "coding-plan" {
		return Outcome{RC: 4}, adapterError(4, "GLM требует api или coding-plan")
	}
	if slices.Contains([]string{
		"deepseek_binary_incompatible", "glm_runtime_incompatible", "glm_plugin_missing",
	},
		supply) {
		return Outcome{RC: 4}, &AdapterError{Code: 4, Marker: "RUNNER_SUPPLY_INCOMPATIBLE=glm"}
	}
	if err := checkWrapperPolicy(policy, run.Effort); err != nil {
		return Outcome{RC: err.Code}, err
	}
	if changed := run.versionError("glm"); changed != nil {
		return Outcome{RC: changed.Code}, changed
	}
	if run.Model == "" {
		return Outcome{RC: 4}, adapterError(4, "GLM требует модель из каталога")
	}
	result, err := runACPWrapper(run, node, "glm", policy.filesystem, prompt,
		[]string{"GRIGDESK_GLM_API_MODE=" + access})
	if err != nil {
		return Outcome{RC: err.Code}, err
	}
	return run.terminal(result, processClass(result.RC))
}
