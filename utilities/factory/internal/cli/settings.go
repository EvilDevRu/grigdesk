package cli

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"regexp"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/runner"
)

var (
	settingsProfile = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	settingsStage   = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	modelFields     = []string{"FAMILY", "FAMILY_FAILOVER", "VERSION", "VARIANT", "EFFORT", "EXACT"}
)

// profileRunnerSettings разбирает профильные команды до работы с конфигурацией.
// Проектные defaults и stage overrides принадлежат одному canonical файлу.
func profileRunnerSettings(args []string, out, diagnostic io.Writer) int {
	if len(args) < 3 || !settingsProfile.MatchString(args[0]) {
		return 2
	}
	name, noun, verb := args[0], args[1], args[2]
	args = args[3:]
	script, _, path := hooks.ProfileFiles(name)
	p, err := runner.ReadProfile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fail(diagnostic, err)
	}
	exists := err == nil
	if !exists {
		if _, err := os.Stat(script); err != nil {
			fmt.Fprintf(diagnostic, "профиль не найден: %s\n", name)
			return 1
		}
	}
	var updates map[string]string
	switch noun {
	case "runner":
		if verb == "show" && exists && len(args) == 0 {
			return showProfileRunners(out, name, p.Values)
		}
		updates = profileRunnerUpdates(verb, args)
	case "model":
		if !exists {
			return fail(diagnostic, runner.ErrInvalidProfile)
		}
		if len(args) < 2 || !settingsStage.MatchString(args[0]) ||
			!runner.ProviderName.MatchString(args[1]) {
			return 2
		}
		stage, provider := args[0], args[1]
		prefix := "MODEL_" + stage + "_" + runner.ProviderKey(provider) + "_"
		if verb == "show" && len(args) == 2 {
			return showModel(out, stage, provider, prefix, p.Values)
		}
		updates = modelUpdates(verb, prefix, args[2:])
	default:
		return unavailable(diagnostic)
	}
	if updates == nil {
		if !exists && noun == "runner" && verb == "show" {
			return fail(diagnostic, runner.ErrInvalidProfile)
		}
		return 2
	}
	if !exists {
		if updates["PROJECT_RUNNER_PRIMARY"] == "" {
			return fail(diagnostic, runner.ErrInvalidProfile)
		}
		updates["RUNNERS_COVERAGE"] = "required"
		p.Values = map[string]string{"CONFIG_REVISION": "0"}
	}
	return writeProfile(path, p, updates, !exists, diagnostic)
}

func writeProfile(
	path string, p runner.ProfileConfig, updates map[string]string, create bool, diagnostic io.Writer,
) int {
	for range 3 {
		err := runner.UpdateProfile(path, p.Values["CONFIG_REVISION"], updates, create)
		switch {
		case err == nil:
			return 0
		case errors.Is(err, runner.ErrInvalidProfile):
			return 2
		case !errors.Is(err, runner.ErrProfileConflict):
			fmt.Fprintln(diagnostic, err)
			return 1
		case create:
			return 73
		}
		var readErr error
		p, readErr = runner.ReadProfile(path)
		if readErr != nil {
			return fail(diagnostic, readErr)
		}
	}
	return 72
}

func showProfileRunners(out io.Writer, name string, values map[string]string) int {
	printProfileRunner(out, name, values["PROJECT_RUNNER_PRIMARY"], values["PROJECT_RUNNER_FAILOVER"])
	for _, key := range slices.Sorted(maps.Keys(values)) {
		if !strings.HasPrefix(key, "STAGE_") || !strings.HasSuffix(key, "_PRIMARY") ||
			values[key] == "" {
			continue
		}
		prefix := strings.TrimSuffix(key, "_PRIMARY")
		printProfileRunner(out, strings.TrimPrefix(prefix, "STAGE_"), values[key], values[prefix+"_FAILOVER"])
	}
	return 0
}

func printProfileRunner(out io.Writer, name, primary, fallback string) {
	if fallback != "" {
		primary += " -> " + fallback
	}
	fmt.Fprintf(out, "%s: %s\n", name, primary)
}

func profileRunnerUpdates(verb string, args []string) map[string]string {
	prefix := "PROJECT_RUNNER"
	if len(args) > 0 && settingsStage.MatchString(args[0]) {
		prefix, args = "STAGE_"+args[0], args[1:]
	}
	switch verb {
	case "clear":
		if prefix != "PROJECT_RUNNER" && len(args) == 0 {
			return map[string]string{prefix + "_PRIMARY": "", prefix + "_FAILOVER": ""}
		}
	case "set":
		if len(args) == 0 || !runner.ProviderName.MatchString(args[0]) {
			return nil
		}
		fallback := ""
		if len(args) == 3 && args[1] == "--failover" && runner.ValidChain(args[2]) {
			fallback = args[2]
		} else if len(args) != 1 {
			return nil
		}
		return map[string]string{prefix + "_PRIMARY": args[0], prefix + "_FAILOVER": fallback}
	}
	return nil
}

func showModel(out io.Writer, stage, provider, prefix string, values map[string]string) int {
	fmt.Fprintf(out, "%s/%s:", stage, provider)
	for _, field := range modelFields {
		if value := values[prefix+field]; value != "" {
			fmt.Fprintf(out, " %s=%s", strings.ToLower(field), value)
		}
	}
	return printLine(out, "")
}

func modelUpdates(verb, prefix string, args []string) map[string]string {
	values := make(map[string]string)
	switch {
	case verb == "clear" && len(args) == 0:
		for _, field := range modelFields {
			values[prefix+field] = ""
		}
	case verb == "set" && len(args) > 0:
		for _, arg := range args {
			key, value, ok := strings.Cut(arg, "=")
			key = strings.ToUpper(key)
			if !ok || !slices.Contains(modelFields, key) {
				return nil
			}
			values[prefix+key] = value
		}
	default:
		return nil
	}
	return values
}
