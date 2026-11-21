package runner

import (
	"debug/elf"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
)

type CodexSharedAccess struct {
	BrokerDir           string
	ReadDirs, WriteDirs []string
	browser             *browserScope
}

const codexPolicyCommand = "_factory-codex-policy"

// sharedCodexArgs изолирует host control и публикует только заявленные корни.
// Для state-only workspace задаётся каталогом состояния и не расширяется до исходников.
func sharedCodexArgs(run Run, policy routePolicy, cwd string) ([]string, error) {
	access := run.CodexShared
	if runtime.GOOS != "linux" || access == nil {
		return nil, fmt.Errorf("Codex shared требует проверенный профиль доступа")
	}
	broker, err := os.Lstat(access.BrokerDir)
	if err != nil || !broker.IsDir() || !privateOwned(broker, 0700, false) ||
		!physicalRunnerPath(access.BrokerDir) {
		return nil, fmt.Errorf("Codex shared требует приватный каталог профильного канала")
	}
	install, err := codexSandboxRuntime(run.Binary)
	if err != nil {
		return nil, err
	}
	factory, err := existingExecutable(run.Factory)
	if err != nil || factory != run.Factory || !physicalRunnerPath(factory) {
		return nil, fmt.Errorf("Codex shared требует физический бинарник фабрики")
	}
	read := []string{factory, install}
	readDirs := slices.Clone(access.ReadDirs)
	if policy.filesystem == "state-only" {
		readDirs = append(readDirs, run.Worktree)
		readDirs = append(readDirs, access.WriteDirs...)
	}
	for _, dir := range readDirs {
		if !physicalRunnerDirectory(dir) {
			return nil, fmt.Errorf("Codex shared получил недопустимый корень чтения")
		}
		read = append(read, dir)
	}
	private := []string{access.BrokerDir, run.Store.ControlDir}
	if runnerPathsOverlap(access.BrokerDir, run.Store.ControlDir) || runnerRootSetsOverlap(read, private) {
		return nil, fmt.Errorf("корень чтения Codex пересекает служебный каталог")
	}
	write := []string{cwd}
	if policy.filesystem != "state-only" {
		write = append(write, run.Store.StateDir)
		write = append(write, access.WriteDirs...)
		write = append(write, policy.addDirs...)
	}
	for _, dir := range write {
		if !physicalRunnerDirectory(dir) {
			return nil, fmt.Errorf("Codex shared получил недопустимый корень записи")
		}
	}
	if runnerRootSetsOverlap(write, append(private, read...)) {
		return nil, fmt.Errorf("корень записи Codex пересекает защищённый каталог")
	}
	read = append(read, access.BrokerDir)
	args := sharedCodexPolicy(cwd, factory, read, access.browser)
	seen := map[string]bool{cwd: true}
	for _, dir := range write {
		if !seen[dir] {
			args = append(args, "--add-dir", dir)
			seen[dir] = true
		}
	}
	return args, nil
}

// sharedCodexPolicy собирает самодостаточный профиль без пользовательских MCP и правил.
// Командный hook принадлежит тому же проверенному поколению, что и writer статуса.
func sharedCodexPolicy(cwd, factory string, read []string, browser *browserScope) []string {
	read = slices.Clone(read)
	slices.Sort(read)
	roots := []string{`":minimal" = "read"`,
		`":workspace_roots" = { "." = "write", ".git" = "read", ".codex" = "read" }`}
	for _, path := range slices.Compact(read) {
		roots = append(roots, strconv.Quote(path)+` = "read"`)
	}
	command := quoteBrowserPath(factory) + " " + codexPolicyCommand
	if browser != nil {
		roots = append(roots, strconv.Quote(browser.directory)+` = "write"`)
		command += " " + quoteBrowserPath(browser.node) + " " + quoteBrowserPath(browser.helper)
	}
	permission := `{ filesystem = { ` + strings.Join(roots, ", ") + ` }, network = { enabled = false } }`
	hook := `[{ matcher = "^Bash$", hooks = [{ type = "command", command = ` +
		strconv.Quote(command) + `, timeout = 5 }] }]`
	return []string{
		"--ignore-user-config", "--ignore-rules", "--strict-config", "--dangerously-bypass-hook-trust",
		"-c", `approval_policy="never"`, "-c", `projects.` + strconv.Quote(cwd) + `.trust_level="untrusted"`,
		"-c", `default_permissions="factory-shared-stand"`, "-c", "permissions.factory-shared-stand=" + permission,
		"-c", "hooks.PreToolUse=" + hook,
	}
}

// codexSandboxRuntime проверяет standalone ELF или точный layout npm.
// Системный launcher остаётся на хосте, а sandbox читает только его runtime.
func codexSandboxRuntime(binary string) (string, error) {
	if !physicalRunnerPath(binary) {
		return "", fmt.Errorf("Codex shared требует физический CLI")
	}
	if nativeCodexELF(binary) {
		return binary, nil
	}
	root := filepath.Dir(filepath.Dir(binary))
	pattern := filepath.Join(root, "node_modules/@openai/codex-linux-*/vendor/*/bin/codex")
	entries, err := filepath.Glob(pattern)
	if err != nil || len(entries) != 1 || !physicalRunnerPath(entries[0]) || !nativeCodexELF(entries[0]) {
		return "", fmt.Errorf("Codex shared не нашёл единственный нативный runtime")
	}
	return root, nil
}

func nativeCodexELF(binary string) bool {
	if real, err := existingExecutable(binary); err != nil || real != binary {
		return false
	}
	file, err := elf.Open(binary)
	if err != nil {
		return false
	}
	defer file.Close()
	return runtime.GOARCH == "amd64" && file.Machine == elf.EM_X86_64 ||
		runtime.GOARCH == "arm64" && file.Machine == elf.EM_AARCH64
}

func physicalRunnerPath(path string) bool {
	if !filepath.IsAbs(path) || path == "/" || filepath.Clean(path) != path ||
		strings.ContainsAny(path, "\r\n\x00") {
		return false
	}
	real, err := filepath.EvalSymlinks(path)
	return err == nil && real == path
}

func physicalRunnerDirectory(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir() && physicalRunnerPath(path)
}

func runnerRootSetsOverlap(left, right []string) bool {
	for _, a := range left {
		for _, b := range right {
			if runnerPathsOverlap(a, b) {
				return true
			}
		}
	}
	return false
}

func runnerPathsOverlap(a, b string) bool {
	return a == b || strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/")
}

const codexShellCommand = `(?i)(?:^|[\s;&|()])(?:command\s+|sudo\s+|env\s+)*(?:/[^\s;&|()]*/)?`

var (
	codexDocker = regexp.MustCompile(codexShellCommand + `docker(?:\s|$)`)
	codexGit    = regexp.MustCompile(codexShellCommand + `git\b[^\n;&|]{0,768}\b(worktree|commit|push)\b`)
	codexGH     = regexp.MustCompile(codexShellCommand + `gh(?:\s|$)`)
	codexPR     = regexp.MustCompile(`(?i)\bpr\b`)
)

// CodexPolicyChild исполняет узкую диагностику PreToolUse из закреплённого ELF.
// Границы доступа независимо обеспечивает встроенный permission profile Codex.
func CodexPolicyChild(args []string, input io.Reader, output io.Writer) (bool, int) {
	if len(args) == 0 || args[0] != codexPolicyCommand {
		return false, 0
	}
	var payload struct {
		Tool  string `json:"tool_name"`
		Input struct {
			Command string `json:"command"`
		} `json:"tool_input"`
	}
	const limit = 1024 * 1024
	raw, err := io.ReadAll(io.LimitReader(input, limit+1))
	if err == nil && len(raw) <= limit {
		err = json.Unmarshal(raw, &payload)
	}
	command := strings.TrimSpace(payload.Input.Command)
	reason := ""
	switch {
	case len(args) != 1 && len(args) != 3, err != nil, payload.Tool != "Bash", command == "",
		strings.ContainsRune(command, 0):
		reason = "Повреждённый или неизвестный запрос PreToolUse."
	case fixedCodexBrowserRequest(command, args[1:]):
		return true, 0
	case codexDocker.MatchString(command) || strings.Contains(command, "/run/docker.sock"):
		reason = "Прямой Docker запрещён. Используйте команды профильного стенда."
	case codexGit.MatchString(command):
		reason = "git worktree, commit и push запрещены для этого стенда."
	case codexGH.MatchString(command) && codexPR.MatchString(command):
		reason = "Операции с pull request запрещены для этого стенда."
	}
	if reason != "" {
		decision := map[string]string{"hookEventName": "PreToolUse", "permissionDecision": "deny",
			"permissionDecisionReason": reason}
		if err := json.NewEncoder(output).Encode(map[string]any{"hookSpecificOutput": decision}); err != nil {
			return true, 2
		}
	}
	return true, 0
}

// fixedCodexBrowserRequest принимает один literal JSON аргумент без shell продолжения.
// Имена CLI и helper задаёт только владелец браузерного permit.
func fixedCodexBrowserRequest(command string, paths []string) bool {
	if len(paths) != 2 || !filepath.IsAbs(paths[0]) || !filepath.IsAbs(paths[1]) {
		return false
	}
	prefix := quoteBrowserPath(paths[0]) + " " + quoteBrowserPath(paths[1]) + " request --input-json "
	literal, ok := strings.CutPrefix(command, prefix)
	if !ok && claudeSettingsPath.MatchString(paths[0]) && claudeSettingsPath.MatchString(paths[1]) {
		literal, ok = strings.CutPrefix(command, paths[0]+" "+paths[1]+" request --input-json ")
	}
	if !ok || len(literal) < 2 || literal[0] != '\'' || literal[len(literal)-1] != '\'' {
		return false
	}
	value := strings.ReplaceAll(literal[1:len(literal)-1], `'\''`, "'")
	var object map[string]json.RawMessage
	return quoteBrowserPath(value) == literal && json.Unmarshal([]byte(value), &object) == nil && object != nil
}
