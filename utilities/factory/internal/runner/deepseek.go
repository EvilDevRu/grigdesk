package runner

import (
	"bytes"
	"fmt"
	"slices"
)

var deepSeekModels = []string{
	`["deepseek-official","deepseek-flash"]`, `["deepseek-official","deepseek-v4-flash"]`,
	`["deepseek-official","deepseek-v4-pro"]`, `["deepseek-official","deepseek-v4-flash-vision-exp"]`,
}

// runDeepSeekAdapter принимает только модели закреплённого provider и filesystem mode.
// Авторизацию разрешено классифицировать до подтверждённого начала активности.
func runDeepSeekAdapter(run Run, node string, policy routePolicy, prompt string) (Outcome, *AdapterError) {
	if err := checkWrapperPolicy(policy, run.Effort); err != nil {
		return Outcome{RC: err.Code}, err
	}
	if changed := run.versionError("deepseek"); changed != nil {
		return Outcome{RC: changed.Code}, changed
	}
	if !slices.Contains(deepSeekModels, run.Model) {
		return Outcome{RC: 4}, adapterError(4, "DeepSeek модель вне каталога")
	}
	mode := policy.filesystem
	if mode == "state-only" {
		mode = "read-only"
	}
	result, err := runACPWrapper(run, node, "deepseek", mode, prompt, nil)
	if err != nil {
		return Outcome{RC: err.Code}, err
	}
	class := processClass(result.RC)
	if class == "unknown" {
		out := readRunLog(run.Dir, "events.jsonl", 64*1024*1024)
		errText := readRunLog(run.Dir, "stderr.log", 1024*1024)
		if bytes.Contains(errText, []byte("Authentication Fails, Your api key:")) && noACPActivity(out) {
			class = "provider_unavailable"
		}
	}
	return run.terminal(result, class)
}

func (run Run) versionError(provider string) *AdapterError {
	if (run.ExpectedVersion != "" && run.Version != run.ExpectedVersion) ||
		(run.ExpectedIdentity != "" && run.RuntimeIdentity != run.ExpectedIdentity) {
		marker := fmt.Sprintf("FACTORY_ERROR=runtime_changed RUNNERS=%s", provider)
		return &AdapterError{Code: 4, Marker: marker}
	}
	return nil
}
