package runner

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

var kimiSection = regexp.MustCompile(`^\[\s*([A-Za-z0-9_."-]+)\s*\]$`)
var kimiEffort = regexp.MustCompile(`^effort\s*=`)
var kimiLogin = regexp.MustCompile(`No model configured[^\n]*/login`)
var kimiQuota = regexp.MustCompile(`provider\.auth_error: 403 [^\n]*usage limit`)
var kimiNetwork = regexp.MustCompile(`fetch failed|socket disconnected|ECONNRESET|ETIMEDOUT|EAI_AGAIN`)

// runKimiAdapter применяет effort в отдельной копии настроек.
// OAuth refresh использует ссылки на два штатных каталога хранилища.
func runKimiAdapter(run Run, binary, home, effort, prompt string) (Outcome, *AdapterError) {
	if effort == "" {
		effort = "high"
	}
	if !slices.Contains([]string{"low", "high", "max"}, effort) {
		return Outcome{RC: 4}, adapterError(4, "Kimi effort должен быть low, high или max")
	}
	runHome := filepath.Join(run.Dir, "kimi-home")
	if err := prepareKimiHome(home, runHome, effort); err != nil {
		return Outcome{RC: 4}, adapterError(4, err.Error())
	}
	args := []string{"-p", prompt, "--output-format", "stream-json"}
	if run.Model != "" {
		args = append(args, "-m", run.Model)
	}
	result, err := run.invoke("kimi", invocation{
		path: binary, cwd: run.Worktree, args: args,
		env: []string{"KIMI_CODE_HOME=" + runHome}, wireHome: runHome,
	})
	if err != nil {
		return Outcome{RC: err.Code}, err
	}
	raw := readRunLog(run.Dir, "events.jsonl", 64*1024*1024)
	diagnostic := readRunLog(run.Dir, "stderr.log", 1024*1024)
	class := classifyKimi(raw, diagnostic, result.RC)
	out, err := run.terminal(result, class)
	out.Usage.Fanout = kimiFanout(raw)
	return out, err
}

func prepareKimiHome(home, destination, effort string) error {
	physical, err := filepath.EvalSymlinks(home)
	if err != nil || physical != home || !filepath.IsAbs(home) {
		return fmt.Errorf("неверный Kimi home")
	}
	config := readRunLog(home, "config.toml", 2*1024*1024)
	if config == nil {
		return fmt.Errorf("Kimi config.toml недоступен")
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		return err
	}
	for _, name := range []string{"credentials", "oauth"} {
		source := filepath.Join(home, name)
		if _, err := os.Stat(source); err == nil {
			if err := os.Symlink(source, filepath.Join(destination, name)); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	data := replaceKimiEffort(string(config), effort)
	return os.WriteFile(filepath.Join(destination, "config.toml"), []byte(data), 0600)
}

func replaceKimiEffort(raw, effort string) string {
	var out []string
	section, seen, written := "", false, false
	value := "effort = " + fmt.Sprintf("%q", effort)
	for _, row := range strings.Split(strings.TrimSuffix(raw, "\n"), "\n") {
		text := strings.TrimSpace(row)
		if header := kimiSection.FindStringSubmatch(text); header != nil {
			if section == "thinking" && !written {
				out, written = append(out, value), true
			}
			first, _, _ := strings.Cut(header[1], ".")
			section = strings.Trim(first, `"`)
			seen = seen || section == "thinking"
		}
		if section == "thinking" && kimiEffort.MatchString(text) {
			if !written {
				out, written = append(out, value), true
			}
		} else {
			out = append(out, row)
		}
	}
	if section == "thinking" && !written {
		out = append(out, value)
	} else if !seen {
		out = append(out, "", "[thinking]", "enabled = true", value)
	}
	return strings.Join(out, "\n") + "\n"
}

func classifyKimi(events, stderr []byte, rc int) string {
	if class := processClass(rc); class != "unknown" {
		return class
	}
	signature := bytes.Join([][]byte{stderr, events}, []byte{'\n'})
	if kimiNoActivity(events) {
		if kimiLogin.Match(signature) {
			return "provider_unavailable"
		}
		if kimiQuota.Match(signature) {
			return "limited"
		}
	}
	if bytes.Contains(signature, []byte("OAuth request to https://auth.kimi.com/api/oauth/token failed")) &&
		kimiNetwork.Match(signature) {
		return "transient"
	}
	return "unknown"
}

func kimiNoActivity(events []byte) bool {
	if events == nil {
		return false
	}
	for _, line := range bytes.Split(events, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var row map[string]any
		if json.Unmarshal(line, &row) != nil || row["role"] == "assistant" || row["role"] == "tool" {
			return false
		}
	}
	return true
}

func kimiFanout(events []byte) int {
	seen := make(map[string]bool)
	for _, line := range bytes.Split(events, []byte{'\n'}) {
		var row struct {
			Calls []struct {
				ID       string `json:"id"`
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tool_calls"`
		}
		if json.Unmarshal(line, &row) != nil {
			continue
		}
		for _, call := range row.Calls {
			if call.ID != "" && call.Function.Name == "Agent" {
				seen[call.ID] = true
			}
		}
	}
	return len(seen)
}
