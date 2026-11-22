package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/json/jsontext"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

// runClaudeAdapter проверяет settings до старта и оставляет только объявленные источники.
// Терминал принимается через run-scoped capability.
func runClaudeAdapter(run Run, binary, settings, prompt string, policy routePolicy) (Outcome, *AdapterError) {
	deferred := settings == ""
	var env []string
	var document *claudeSettings
	if deferred {
		var err error
		document, err = run.claudeSettingsDocument(policy)
		if err != nil {
			return Outcome{RC: 78}, adapterError(78, err.Error())
		}
		generated, err := run.writeClaudeSettings(document)
		if err != nil {
			return Outcome{RC: 78}, adapterError(78, err.Error())
		}
		defer os.Remove(generated)
		settings = generated
		if run.AgentControlDir != "" {
			env = append(env, "PROFILE_AGENT_CONTROL_DIR="+run.AgentControlDir)
		}
	}
	if err := trustedClaudeSettings(run.Store.ControlDir, settings); err != nil {
		return Outcome{RC: 78}, adapterError(78, err.Error())
	}
	args := []string{"-p", prompt, "--output-format", "stream-json", "--verbose"}
	settingsIndex := len(args) + 1
	args = append(args, "--settings", settings, "--setting-sources", "", "--strict-mcp-config",
		"--disable-slash-commands", "--permission-mode", "acceptEdits")
	if run.Model != "" {
		args = append(args, "--model", run.Model)
	}
	if run.Effort != "" {
		args = append(args, "--effort", run.Effort)
	}
	call := invocation{
		path: binary, cwd: run.Worktree, args: args, env: env, deferred: deferred,
	}
	var browserFile string
	if document != nil {
		defer func() {
			if browserFile != "" {
				_ = os.Remove(browserFile)
			}
		}()
		call.configureBrowser = func(_ context.Context, launch *host.ProcessLaunch, scope *browserScope) error {
			if !claudeSettingsPath.MatchString(scope.node) || !claudeSettingsPath.MatchString(scope.helper) {
				return fmt.Errorf("browser_runtime_invalid")
			}
			allow := "Bash(" + scope.node + " " + scope.helper + " request:*)"
			document.Permissions.Allow = append(document.Permissions.Allow, allow)
			var err error
			browserFile, err = run.writeClaudeSettings(document)
			if err == nil {
				launch.Args[settingsIndex] = browserFile
			}
			return err
		}
	}
	result, err := run.invoke("claude", call)
	if err != nil {
		return Outcome{RC: err.Code}, err
	}
	stream := readRunLog(run.Dir, "events.jsonl", 64*1024*1024)
	stderr := readRunLog(run.Dir, "stderr.log", 1024*1024)
	class, limit := classifyClaude(stream, stderr, result.RC)
	out, err := run.terminal(result, class)
	out.LimitUntil = limit
	return out, err
}

func trustedClaudeSettings(control, path string) error {
	base, err := filepath.EvalSymlinks(control)
	relative, relativeErr := filepath.Rel(control, path)
	if err != nil || base != control || filepath.Dir(control) == control || !filepath.IsAbs(control) ||
		!filepath.IsAbs(path) || filepath.Clean(path) != path || relativeErr != nil ||
		relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("Claude settings вне физического control root")
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || real != path {
		return fmt.Errorf("Claude settings: путь должен быть физическим")
	}
	root, err := os.OpenRoot(control)
	if err != nil {
		return err
	}
	defer root.Close()
	if !privateDirectory(control) {
		return fmt.Errorf("Claude settings: недоверенный control root")
	}
	file, err := host.OpenAt(root, relative, os.O_RDONLY, 0, host.Nonblocking)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	const limit = 2 * 1024 * 1024
	if err != nil || !info.Mode().IsRegular() || (!host.PrivateMode(file, info, 0400) || !host.SingleLink(file, info)) || info.Size() > limit {
		return fmt.Errorf("Claude settings: недоверенный файл")
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || len(raw) > limit {
		return fmt.Errorf("Claude settings: не удалось прочитать JSON")
	}
	return validateClaudeSettings(raw, control)
}

// privateDirectory удерживает открытый каталог на протяжении проверки прав.
// Смена пути после открытия не подменяет подтверждённого владельца.
func privateDirectory(path string) bool {
	file, err := host.OpenPath(path, os.O_RDONLY, 0, host.Directory)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	return err == nil && info.IsDir() && host.PrivateMode(file, info, 0700) && host.FileOwner(file, info)
}

func validateClaudeSettings(raw []byte, control string) error {
	var value struct {
		Permissions struct {
			Deny []string `json:"deny"`
		} `json:"permissions"`
		Sandbox map[string]any `json:"sandbox"`
	}
	if !jsontext.Value(raw).IsValid() || json.Unmarshal(raw, &value) != nil {
		return fmt.Errorf("Claude settings: неверный JSON")
	}
	path := "//" + strings.TrimPrefix(control, "/")
	for _, tool := range []string{"Read", "Edit", "Write", "NotebookEdit"} {
		for _, pattern := range []string{path, path + "/**"} {
			if !slices.Contains(value.Permissions.Deny, tool+"("+pattern+")") {
				return fmt.Errorf("Claude settings: неполный permissions.deny")
			}
		}
	}
	if box := value.Sandbox; box != nil {
		flags := box["enabled"] == true && box["failIfUnavailable"] == true &&
			box["allowUnsandboxedCommands"] == false
		filesystem, _ := box["filesystem"].(map[string]any)
		_, excluded := box["excludedCommands"]
		_, allow := filesystem["allowRead"]
		if !flags || excluded || allow || !claudeDenyRule(filesystem["denyRead"], control) ||
			!claudeDenyRule(filesystem["denyWrite"], control) {
			return fmt.Errorf("Claude settings: неподтверждённый sandbox")
		}
	}
	return nil
}

func claudeDenyRule(value any, control string) bool {
	rules, _ := value.([]any)
	return slices.Contains(rules, any(control)) && slices.Contains(rules, any(control+"/**"))
}

type claudeRow struct {
	Type   string `json:"type"`
	Denied []any  `json:"permission_denials"`
	Error  bool   `json:"is_error"`
	Limit  struct {
		Status string `json:"status"`
		Reset  int64  `json:"resetsAt"`
	} `json:"rate_limit_info"`
}

func classifyClaude(stream, stderr []byte, rc int) (string, string) {
	if kind := processClass(rc); kind != "unknown" {
		return kind, ""
	}
	class, reset, activity := "unknown", "", false
	known := stream != nil
	for _, line := range bytes.Split(stream, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var event claudeRow
		if json.Unmarshal(line, &event) != nil || event.Type == "" {
			known = false
			continue
		}
		if event.Type == "subscription_limit_reached" ||
			(event.Type == "rate_limit_event" && event.Limit.Status == "rejected") {
			class = "limited"
			if event.Limit.Reset > 0 {
				reset = strconv.FormatInt(event.Limit.Reset, 10)
			}
		}
		if event.Type == "assistant" || event.Type == "tool_use" || event.Type == "tool_result" {
			activity = true
		}
	}
	if class == "limited" && known {
		return class, reset
	}
	kind := classifyProviderSignature(stderr)
	if kind == "provider_unavailable" && (activity || !known) {
		return "unknown", ""
	}
	if kind == "limited" {
		return "unknown", ""
	}
	return kind, ""
}

// claudeDenials суммирует подтверждённые result-записи, сохраняя отсутствие результата.
// Обрыв turn без result не выдаётся за нулевое число отказов.
func claudeDenials(stream []byte) (int, bool) {
	total, found := 0, false
	for _, line := range bytes.Split(stream, []byte{'\n'}) {
		var value claudeRow
		if json.Unmarshal(line, &value) == nil && value.Type == "result" {
			found = true
			total += len(value.Denied)
		}
	}
	return total, found
}
