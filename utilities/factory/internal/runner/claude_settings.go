package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var claudeSettingsPath = regexp.MustCompile(`^/[A-Za-z0-9._/@%+=,:~-]+$`)

type claudeSettings struct {
	Permissions struct {
		Allow []string `json:"allow"`
		Deny  []string `json:"deny"`
	} `json:"permissions"`
	Sandbox map[string]any `json:"sandbox"`
}

// writeClaudeSettings выпускает закрытый файл на один запуск.
// Прежний fixture-путь остаётся отдельным входом общего проверяющего кода.
func (run Run) writeClaudeSettings(document *claudeSettings) (string, error) {
	if !physicalRunnerDirectory(run.Store.ControlDir) {
		return "", fmt.Errorf("нет физического служебного каталога Claude")
	}
	if !privateDirectory(run.Store.ControlDir) {
		return "", fmt.Errorf("нет приватного служебного каталога Claude")
	}
	file, err := os.CreateTemp(run.Store.ControlDir, ".claude-settings-")
	if err != nil {
		return "", err
	}
	write := json.NewEncoder(file).Encode(document)
	if err := errors.Join(write, file.Chmod(0400), file.Close()); err != nil {
		_ = os.Remove(file.Name())
		return "", err
	}
	return file.Name(), nil
}

// claudeSettingsDocument задаёт статус через очередь конкретного запуска.
// Bash и прямые инструменты записи проверяют общий запрет control и исходников state-only.
func (run Run) claudeSettingsDocument(policy routePolicy) (*claudeSettings, error) {
	control, state, work := run.Store.ControlDir, run.Store.StateDir, run.Worktree
	for _, path := range []string{run.Factory, control, state, work} {
		if !claudeSettingsPath.MatchString(path) || filepath.Clean(path) != path {
			return nil, fmt.Errorf("непредставимый путь в правилах Claude")
		}
	}
	if runnerRootSetsOverlap([]string{control}, []string{state, work}) {
		return nil, fmt.Errorf("корни состояния или проекта пересекают служебный каталог Claude")
	}
	deny := claudeDirectoryRules(control, "Read", "Edit", "Write", "NotebookEdit")
	denyWrite := []string{control, control + "/**"}
	if broker := run.AgentControlDir; broker != "" {
		if !claudeSettingsPath.MatchString(broker) || !physicalRunnerDirectory(broker) ||
			runnerRootSetsOverlap([]string{broker}, []string{control, state, work}) {
			return nil, fmt.Errorf("недопустимый профильный канал Claude")
		}
		deny = append(deny, claudeDirectoryRules(broker, "Edit", "Write", "NotebookEdit")...)
		denyWrite = append(denyWrite, broker, broker+"/**")
	}
	allowWrite := []string{state}
	allow := append(claudeDirectoryRules(state, "Write", "Edit"), "Read(//**)",
		"Bash("+run.Factory+" stage-result:*)", "Bash("+run.Factory+" stage-progress:*)")
	for _, cmd := range []string{"git", "grep", "rg", "ls", "cat", "head", "tail", "wc", "find", "cd", "printf"} {
		allow = append(allow, "Bash("+cmd+":*)")
	}
	if run.ReadAgentRules != nil {
		profileAllow, profileDeny, err := run.ReadAgentRules(run.context)
		if err != nil {
			return nil, err
		}
		allow = append(allow, profileAllow...)
		deny = append(deny, profileDeny...)
	}
	switch policy.filesystem {
	case "state-only":
		deny = append(deny, claudeDirectoryRules(work, "Edit", "Write", "NotebookEdit")...)
		denyWrite = append(denyWrite, work, work+"/**")
	case "workspace-write", "transactional-write":
		allowWrite = append(allowWrite, work)
	default:
		return nil, fmt.Errorf("неподдерживаемая файловая политика Claude")
	}
	document := &claudeSettings{
		Sandbox: map[string]any{
			"enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false,
			"filesystem": map[string][]string{
				"denyRead": {control, control + "/**"}, "denyWrite": denyWrite, "allowWrite": allowWrite,
			},
		},
	}
	document.Permissions.Allow, document.Permissions.Deny = allow, deny
	return document, nil
}

func claudeDirectoryRules(directory string, tools ...string) []string {
	path := "//" + strings.TrimPrefix(directory, "/")
	var rules []string
	for _, tool := range tools {
		rules = append(rules, tool+"("+path+")", tool+"("+path+"/**)")
	}
	return rules
}
