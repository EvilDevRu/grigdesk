package runner

import "strings"

// runQwenAdapter передаёт filesystem policy без переименования режима.
// Исполняемый вход берётся из descriptor; credentials остаются в env.
func runQwenAdapter(
	run Run, wrapper string, policy routePolicy, model, prompt string,
) (Outcome, *AdapterError) {
	if err := checkWrapperPolicy(policy, ""); err != nil {
		return Outcome{RC: err.Code}, err
	}
	if len(model) > 512 || strings.ContainsAny(model, "\r\n\x00") {
		return Outcome{RC: 4}, adapterError(4, "неверный идентификатор модели Qwen")
	}
	run.Model = model
	result, err := runACPWrapper(run, wrapper, "qwen", policy.filesystem, prompt, []string{
		"GRIGDESK_QWEN_BIN=" + run.Binary, "GRIGDESK_QWEN_CONFIG_ROOT=" + run.Worktree,
	})
	if err != nil {
		return Outcome{RC: err.Code}, err
	}
	return run.terminal(result, processClass(result.RC))
}
