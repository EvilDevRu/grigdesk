package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

// debugSettings сохраняет формат show/set/clear во всех трёх областях.
// Валидация CLI завершается до обращения к файлам настроек.
func debugSettings(r request, profile string, args []string, out, diagnostic io.Writer) int {
	now := int64(time.Now().Unix())
	if os.Getenv("FACTORY_TESTING") == "1" {
		if fixture, ok := debugNumber(os.Getenv("FACTORY_DEBUG_NOW")); ok {
			now = fixture
		}
	}
	verb, setting, ok := debugUpdate(args, r.task != "", now)
	if !ok || (profile != "" && !settingsProfile.MatchString(profile)) {
		return 2
	}
	config := state.DebugConfigRoot(map[string]string{
		"FACTORY_CONFIG_ROOT": os.Getenv("FACTORY_CONFIG_ROOT"), "HOME": os.Getenv("HOME"),
	})
	if profile != "" {
		file, _, runners := hooks.ProfileFiles(profile)
		if hooks.CheckFile(file, "profile") != nil && hooks.CheckFile(runners, "runners-config") != nil {
			return fail(diagnostic, fmt.Errorf("профиль не найден: %s", profile))
		}
	}
	if r.task != "" {
		store := state.Store{StateDir: r.stateDir(),
			ControlDir: firstNonempty(os.Getenv("FACTORY_CONTROL_ROOT"), filepath.Join(config, "control"))}
		attempt, configured, err := store.ReadTaskDebug(r.task)
		if err != nil {
			return fail(diagnostic, err)
		}
		if verb == "show" {
			effective := state.ResolveDebug(config, attempt.Profile, configured, now)
			return printDebug(out, "task", configured, effective)
		}
		return debugWriteResult(diagnostic, store.WriteTaskDebug(attempt, setting))
	}
	if verb != "show" {
		// При первом запуске ещё нет родителя стандартного config root.
		if os.Getenv("FACTORY_CONFIG_ROOT") == "" && filepath.IsAbs(config) {
			home, err := filepath.EvalSymlinks(filepath.Dir(filepath.Dir(config)))
			if err != nil || home != filepath.Dir(filepath.Dir(config)) {
				return fail(diagnostic, fmt.Errorf("нужен физический HOME для диагностики"))
			}
			if err := os.Mkdir(filepath.Dir(config), 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return fail(diagnostic, err)
			}
		}
		return debugWriteResult(diagnostic, state.WriteDebugFile(config, profile, setting))
	}
	scope := "global"
	if profile != "" {
		scope = "profile"
	}
	const inherited = "inherit"
	configured, err := state.ReadDebugFile(config, profile)
	if err != nil {
		configured = state.DebugSetting{Level: inherited}
	}
	effective := state.ResolveDebug(config, profile, state.DebugSetting{Level: inherited}, now)
	return printDebug(out, scope, configured, effective)
}

// debugUpdate проверяет длительность как целое число с единицей измерения.
// Настройка задачи без явного TTL ограничена историческим двухчасовым значением.
func debugUpdate(args []string, task bool, now int64) (string, state.DebugSetting, bool) {
	value := state.DebugSetting{Level: "inherit"}
	if len(args) == 0 {
		return "", value, false
	}
	verb := args[0]
	switch verb {
	case "show", "clear":
		return verb, value, len(args) == 1
	case "set":
		if len(args) != 2 && (len(args) != 4 || args[2] != "--for") {
			return verb, value, false
		}
	default:
		return verb, value, false
	}
	value.Level = args[1]
	if !value.Valid() || value.Level == "inherit" {
		return verb, value, false
	}
	var seconds int64
	const maxDuration = 365 * 24 * 60 * 60
	if len(args) == 4 {
		duration := args[3]
		if len(duration) < 2 {
			return verb, value, false
		}
		scale := map[byte]int64{'s': 1, 'm': 60, 'h': 3600, 'd': 86400}[duration[len(duration)-1]]
		amount, ok := debugNumber(duration[:len(duration)-1])
		if !ok || scale == 0 || amount == 0 || amount > maxDuration/scale {
			return verb, value, false
		}
		seconds = amount * scale
	} else if task && value.Level != "off" {
		var ok bool
		seconds, ok = debugNumber(firstNonempty(os.Getenv("FACTORY_DEBUG_TASK_DEFAULT_TTL"), "7200"))
		if !ok || seconds == 0 || seconds > maxDuration {
			return verb, value, false
		}
	}
	if seconds > 0 {
		value.Expires = now + seconds
	}
	return verb, value, value.Valid()
}

func debugNumber(raw string) (int64, bool) {
	parsed, err := strconv.ParseInt(raw, 10, 64)
	return parsed, err == nil && parsed >= 0 && strconv.FormatInt(parsed, 10) == raw
}

func debugWriteResult(diagnostic io.Writer, err error) int {
	if err == nil {
		return 0
	}
	if errors.Is(err, state.ErrConflict) {
		fmt.Fprintln(diagnostic, err)
		return 75
	}
	return fail(diagnostic, err)
}

func printDebug(
	out io.Writer, scope string, configured state.DebugSetting, effective state.DebugResolution,
) int {
	fmt.Fprintf(out, "scope: %s\nconfigured: %s\nconfigured_expires_at: %d\n",
		scope, configured.Level, configured.Expires)
	fmt.Fprintf(out, "effective: %s\nsource: %s\nexpires_at: %d\n",
		effective.Level, effective.Source, effective.Expires)
	return 0
}
