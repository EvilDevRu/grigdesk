package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

var ordinalSuffix = regexp.MustCompile(`(?i)([0-9])(st|nd|rd|th)\b`)
var codexTryAgain = regexp.MustCompile(`(?i)try again at ([^"\\\]\r\n]+)`)
var safeEffort = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,24}$`)

// runCodexAdapter передаёт prompt в stdin и использует узкий deferred статус.
// Класс отказа берётся из машинного события и совместимого кода завершения.
func runCodexAdapter(run Run, binary, prompt string, policy routePolicy) (Outcome, *AdapterError) {
	run.Binary = binary
	args, cwd, err := codexArgs(run, policy)
	if err != nil {
		return Outcome{RC: err.Code}, err
	}
	call := invocation{
		path: binary, cwd: cwd, args: args, stdin: strings.NewReader(prompt + "\n"), deferred: true,
	}
	if run.CodexShared != nil {
		call.configureBrowser = func(ctx context.Context, launch *host.ProcessLaunch, browser *browserScope) error {
			roots, err := browser.codexReadRoots(ctx)
			if err != nil {
				return err
			}
			access := *run.CodexShared
			access.ReadDirs = append(append([]string{}, access.ReadDirs...), roots...)
			access.browser = browser
			configured := run
			configured.CodexShared = &access
			argv, _, refusal := codexArgs(configured, policy)
			if refusal != nil {
				return refusal
			}
			launch.Args = argv
			return nil
		}
	}
	result, err := run.invoke("codex", call)
	if err != nil {
		return Outcome{RC: err.Code}, err
	}
	raw := readRunLog(run.Dir, "events.jsonl", 64*1024*1024)
	class, tokens := classifyCodex(raw, result.RC)
	out, failure := run.terminal(result, class)
	out.Usage = tokens
	if class == "limited" {
		detail := readRunLog(run.Dir, "stderr.log", 1024*1024)
		out.LimitUntil = codexLimitUntil(append(append(raw, '\n'), detail...))
	}
	return out, failure
}

func codexArgs(run Run, policy routePolicy) ([]string, string, *AdapterError) {
	args := []string{"exec", "--json", "--skip-git-repo-check"}
	sandbox, cwd := policy.sandbox, run.Worktree
	switch policy.filesystem {
	case "state-only":
		sandbox, cwd = "read-only", run.Store.StateDir
	case "workspace-write", "transactional-write":
		if sandbox == "" {
			sandbox = "workspace-write"
		}
	default:
		return nil, "", adapterError(4, "Codex filesystem policy не поддерживается")
	}
	if sandbox != "read-only" && sandbox != "workspace-write" {
		return nil, "", adapterError(4, "неподдерживаемый sandbox Codex")
	}
	restricted := policy.shared || run.CodexShared != nil
	addDirs := policy.addDirs
	if restricted {
		restricted, err := sharedCodexArgs(run, policy, cwd)
		if err != nil {
			return nil, "", adapterError(4, err.Error())
		}
		args = append(args, restricted...)
		addDirs = nil
	} else if policy.filesystem == "state-only" && runtime.GOOS == "linux" {
		permissions, err := codexStateOnlyArgs(run)
		if err != nil {
			return nil, "", err
		}
		args = append(args, permissions...)
		addDirs = nil
	} else if policy.filesystem == "workspace-write" && sandbox == "workspace-write" {
		args = append(args, "--approve-for-me")
	} else {
		args = append(args, "--sandbox", sandbox)
		if policy.filesystem == "state-only" {
			args = append(args, "-c", `approval_policy="never"`)
		}
	}
	if sandbox == "workspace-write" && !restricted {
		args = append(args, "-c", "sandbox_workspace_write.network_access=true")
	}
	if run.Model != "" {
		args = append(args, "-m", run.Model)
	}
	if run.Effort != "" {
		if !safeEffort.MatchString(run.Effort) {
			return nil, "", adapterError(4, "неверный Codex effort")
		}
		args = append(args, "-c", "model_reasoning_effort="+strconv.Quote(run.Effort))
	}
	for _, dir := range addDirs {
		real, err := filepath.EvalSymlinks(dir)
		if err != nil || real != dir || !filepath.IsAbs(dir) {
			return nil, "", adapterError(4, "неверный дополнительный корень Codex")
		}
		args = append(args, "--add-dir", dir)
	}
	return append(args, "-o", filepath.Join(run.Dir, "last.md"), "-"), cwd, nil
}

func codexStateOnlyArgs(run Run) ([]string, *AdapterError) {
	stateDir, controlDir := run.Store.StateDir, run.Store.ControlDir
	for _, dir := range []string{stateDir, controlDir, run.Worktree} {
		if !physicalRunnerDirectory(dir) {
			return nil, adapterError(4, "Codex state-only требует физические каталоги")
		}
	}
	protected := []string{controlDir, run.Worktree}
	if run.AgentControlDir != "" {
		protected = append(protected, run.AgentControlDir)
	}
	if runnerRootSetsOverlap([]string{stateDir}, protected) {
		return nil, adapterError(4, "каталог записи Codex state-only пересекает защищённый каталог")
	}
	permission := `{ filesystem = { ":root" = "read", ` + strconv.Quote(stateDir) +
		` = "write", ` + strconv.Quote(controlDir) + ` = "none" }, network = { enabled = false } }`
	return []string{
		"-c", `approval_policy="never"`,
		"-c", `default_permissions="factory-state-only"`,
		"-c", "permissions.factory-state-only=" + permission,
	}, nil
}

type codexEvent struct {
	Type  string          `json:"type"`
	Error json.RawMessage `json:"error"`
	Usage struct {
		Input      int64 `json:"input_tokens"`
		Output     int64 `json:"output_tokens"`
		Cached     int64 `json:"cached_input_tokens"`
		CacheWrite int64 `json:"cache_write_input_tokens"`
	} `json:"usage"`
}

func classifyCodex(raw []byte, rc int) (string, usage) {
	var tokens usage
	valid, activity, class := raw != nil, false, ""
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var e codexEvent
		if json.Unmarshal(line, &e) != nil || e.Type == "" {
			valid = false
			continue
		}
		switch e.Type {
		case "usage_limit_reached":
			class = "limited"
		case "turn.failed", "error":
			signature := e.Error
			if len(signature) == 0 {
				signature = line
			}
			class = classifyProviderSignature(signature)
		case "turn.started", "thread.started":
			class = ""
		default:
			class, activity = "", true
		}
		if e.Type == "turn.completed" {
			tokens = usage{InputTokens: e.Usage.Input, OutputTokens: e.Usage.Output,
				CachedInputTokens: e.Usage.Cached, CacheWriteInputTokens: e.Usage.CacheWrite}
		}
	}
	switch {
	case rc == 0:
		return "ok", tokens
	case rc == 124:
		return "timeout", tokens
	case !valid || class == "":
		return "unknown", tokens
	case class == "provider_unavailable" && activity:
		return "unknown", tokens
	default:
		return class, tokens
	}
}

var statusCode = regexp.MustCompile(`\b(401|403|413|429|500|502|503|504)\b`)

func classifyProviderSignature(raw []byte) string {
	s := strings.ToLower(string(raw))
	switch {
	case strings.Contains(s, "usage_limit_reached"), strings.Contains(s, "subscription_limit_reached"):
		return "limited"
	case strings.Contains(s, "permission denied"), strings.Contains(s, "sandbox_denied"):
		return "denied"
	case strings.Contains(s, "context_length_exceeded"), strings.Contains(s, "context window"):
		return "context_overflow"
	case strings.Contains(s, "too many requests"), strings.Contains(s, "rate_limit_error"):
		return "transient"
	}
	switch statusCode.FindString(s) {
	case "401", "403":
		return "provider_unavailable"
	case "413":
		return "context_overflow"
	case "429", "500", "502", "503", "504":
		return "transient"
	default:
		return "unknown"
	}
}

// codexLimitUntil использует фразу только для срока уже доказанного quota отказа.
func codexLimitUntil(data []byte) string {
	matches := codexTryAgain.FindAllSubmatch(data, -1)
	for i := len(matches) - 1; i >= 0; i-- {
		text := strings.TrimSpace(string(matches[i][1]))
		if len(text) > 64 {
			continue
		}
		text = ordinalSuffix.ReplaceAllString(text, "$1")
		text = strings.ReplaceAll(text, ",", "")
		text = strings.TrimSuffix(text, ".")
		for _, format := range []string{"2006-01-02 15:04", "Jan 2 2006 3:04 PM", "January 2 2006 3:04 PM"} {
			if stamp, err := time.ParseInLocation(format, text, time.Local); err == nil {
				return strconv.FormatInt(stamp.Unix(), 10)
			}
		}
	}
	return ""
}

func readRunLog(dir, name string, limit int64) []byte {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil
	}
	defer root.Close()
	file, err := host.OpenAt(root, name, os.O_RDONLY, 0, host.Nonblocking)
	if err != nil {
		return nil
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() > limit {
		return nil
	}
	data := make([]byte, before.Size())
	if len(data) > 0 {
		if n, err := file.ReadAt(data, 0); err != nil || n != len(data) {
			return nil
		}
	}
	after, err := file.Stat()
	if err != nil || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return nil
	}
	return data
}
