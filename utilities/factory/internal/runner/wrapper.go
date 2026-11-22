package runner

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

func checkWrapperPolicy(policy routePolicy, effort string) *AdapterError {
	if policy.filesystem != "state-only" && policy.filesystem != "workspace-write" {
		return adapterError(4, "filesystem policy не поддерживается")
	}
	if !slices.Contains([]string{"", "off", "low", "high", "max"}, effort) {
		return adapterError(4, "effort не поддерживается")
	}
	return nil
}

// runACPWrapper готовит private prompt под run и передаёт только filename.
// Wrapper получает точные пути binary/cwd и проверенный набор опций.
func runACPWrapper(
	run Run, node, provider, mode, prompt string, environment []string,
) (host.ProcessResult, *AdapterError) {
	if !filepath.IsAbs(run.Binary) || filepath.Clean(run.Binary) != run.Binary {
		return host.ProcessResult{}, adapterError(4, "нет физического бинарника из descriptor")
	}
	info, err := os.Stat(run.Binary)
	physical, pathErr := filepath.EvalSymlinks(run.Binary)
	if err != nil || pathErr != nil || physical != run.Binary ||
		!host.Executable(run.Binary, info) {
		return host.ProcessResult{}, adapterError(4, "бинарник descriptor недоступен")
	}
	if run.Wrapper != "" {
		actual, err := filepath.EvalSymlinks(run.Wrapper)
		if err != nil || actual != run.Wrapper || !filepath.IsAbs(run.Wrapper) {
			return host.ProcessResult{}, adapterError(4, "wrapper не прошёл проверку path")
		}
	}
	root := filepath.Join(run.Dir, provider)
	if err := os.Mkdir(root, 0700); err != nil {
		return host.ProcessResult{}, adapterError(78, err.Error())
	}
	file := filepath.Join(root, "prompt.md")
	if err := os.WriteFile(file, []byte(prompt), 0600); err != nil {
		return host.ProcessResult{}, adapterError(78, err.Error())
	}
	cwd := run.Worktree
	if mode == "state-only" || mode == "read-only" {
		cwd = run.Store.StateDir
	}
	args := make([]string, 0, 24)
	if run.Wrapper != "" {
		args = append(args, run.Wrapper)
	}
	args = append(args, "--bin", run.Binary, "--cwd", cwd, "--run-dir", run.Dir,
		"--runtime-home", filepath.Join(root, "runtime"), "--prompt-file", file,
		"--model", run.Model, "--mode", mode)
	if run.Effort != "" && provider != "qwen" {
		args = append(args, "--effort", run.Effort)
	}
	if run.RuntimeHome != "" && provider == "deepseek" {
		args = append(args, "--artifact-dir", run.RuntimeHome)
	}
	if run.RuntimeIdentity != "" && provider != "qwen" {
		args = append(args, "--runtime-identity", run.RuntimeIdentity, "--runtime-version", run.Version)
	}
	if run.CacheDirectory != "" && provider != "qwen" {
		args = append(args, "--cache-dir", run.CacheDirectory)
	}
	return run.invoke(provider, invocation{path: node, cwd: cwd, args: args,
		env: environment, deferred: true})
}

func noACPActivity(raw []byte) bool {
	if raw == nil {
		return false
	}
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var row struct {
			Event string `json:"event"`
		}
		if json.Unmarshal(line, &row) != nil || row.Event == "" ||
			row.Event == "agent_message_chunk" || row.Event == "tool_call" {
			return false
		}
	}
	return true
}

func processClass(rc int) string {
	switch rc {
	case 0:
		return "ok"
	case 124:
		return "timeout"
	default:
		return "unknown"
	}
}
