package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/host"
)

type profileCheck struct {
	profiles  []string
	environ   []string
	quick     bool
	preflight bool
}

// runProfileCheck обрабатывает профили в указанном порядке.
// При отсутствии имён берутся только каталоги с обычным profile.sh.
func runProfileCheck(args []string, out, diagnostic io.Writer) int {
	req, err := parseProfileCheck(args)
	if err != nil {
		return fail(diagnostic, err)
	}
	if req.quick {
		root, err := os.MkdirTemp("", "factory-check.")
		if err != nil {
			return fail(diagnostic, err)
		}
		defer os.RemoveAll(root)
		if err := req.isolate(root); err != nil {
			return fail(diagnostic, err)
		}
	}
	ok := true
	for _, profile := range req.profiles {
		if err := req.check(profile, out); err != nil {
			fmt.Fprintf(out, "✗ %s\n\n", err)
			ok = false
		}
	}
	if ok {
		return printLine(out, "ГОТОВО: профили можно запускать")
	}
	fmt.Fprintln(out, "ЕСТЬ ПРОБЛЕМЫ — см. выше")
	return 1
}

// parseProfileCheck принимает порядок флагов из отдельного factory-check.
// Невалидные имена отклоняются до открытия профиля.
func parseProfileCheck(args []string) (profileCheck, error) {
	req := profileCheck{environ: os.Environ()}
	for _, arg := range args {
		switch arg {
		case "--quick":
			req.quick = true
		case "--host-preflight":
			req.preflight = true
		default:
			if !profileName.MatchString(arg) {
				return req, fmt.Errorf("profile-check: недопустимый профиль %q", arg)
			}
			req.profiles = append(req.profiles, arg)
		}
	}
	if len(req.profiles) != 0 {
		return req, nil
	}
	root := hooks.ProfileRoot()
	entries, err := os.ReadDir(root)
	if err != nil && !os.IsNotExist(err) {
		return req, err
	}
	for _, entry := range entries {
		name := entry.Name()
		script := filepath.Join(root, name, "profile.sh")
		if entry.IsDir() && profileName.MatchString(name) && hooks.CheckFile(script, "profile") == nil {
			req.profiles = append(req.profiles, name)
		}
	}
	return req, nil
}

// isolate выделяет одноразовые state/config/cache для quick.
// Первоначальные пути остаются доступны только явному host-preflight.
func (r *profileCheck) isolate(root string) error {
	dirs := map[string]string{
		"FACTORY_STATE": "state", "STATE_DIR": "state", "FACTORY_CONFIG_ROOT": "config",
		"XDG_CONFIG_HOME": "xdg-config", "XDG_STATE_HOME": "xdg-state", "XDG_CACHE_HOME": "xdg-cache",
	}
	for key, suffix := range dirs {
		dir := filepath.Join(root, suffix)
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		r.environ = append(r.environ, key+"="+dir)
	}
	if os.Getenv("FACTORY_TESTING") == "1" {
		if report := os.Getenv("FACTORY_CHECK_STATE_REPORT"); report != "" {
			return os.WriteFile(report, []byte(filepath.Join(root, "state")+"\n"), 0600)
		}
	}
	return nil
}

// check сначала проверяет явную декларацию запуска, затем ABI и конфигурацию.
// launchable:false не требует хука и не запускает проверку исполнителя.
func (r profileCheck) check(profile string, out io.Writer) error {
	if os.Getenv("FACTORY_TESTING") == "1" && os.Getenv("FACTORY_CHECK_ONLY_ISOLATION") == "1" {
		return nil
	}
	fmt.Fprintf(out, "── %s ───────────────────────────────────────────\n", profile)
	script, graph, runners := hooks.ProfileFiles(profile)
	metadata, err := hooks.ReadProfileGraph(graph)
	if err != nil {
		return err
	}
	if metadata.Nonlaunch {
		if metadata.RouteV2 {
			return fmt.Errorf("launchable: false вместе с capability route-v2 — оставь что-то одно")
		}
		fmt.Fprintln(out, "○ запуск: профиль задач не ведёт (launchable: false)")
		return nil
	}
	if !metadata.RouteV2 {
		return fmt.Errorf("route: capability route-v2 отсутствует; запуск fail-closed")
	}
	ctx := context.Background()
	err = hooks.CheckProfileHooks(ctx, hooks.Invocation{
		Profile: script, Directory: filepath.Dir(script), Env: r.environ, Timeout: 30 * time.Second,
	})
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "✓ route: capability заявлена, workspace/stand hooks на месте")
	fmt.Fprintln(out, "✓ хост стенда: имя годится для адреса, который получит браузерный агент")
	config, err := hooks.RunnerConfig(runners)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "✓ исполнители: canonical config обязателен и валиден")

	if r.preflight {
		if os.Getenv("RUN_HOST_PREFLIGHT") != "1" {
			return fmt.Errorf("host preflight требует явного RUN_HOST_PREFLIGHT=1")
		}
		if err := probeProfileProviders(ctx, config, filepath.Dir(script)); err != nil {
			return err
		}
		fmt.Fprintln(out, "✓ исполнители: host preflight готов")
	}
	fmt.Fprintln(out)
	return nil
}

// probeProfileProviders проверяет локальную версию известных метаданных CLI.
// Маршрут, prompt и аргументы запуска модели в этот вызов не передаются.
func probeProfileProviders(ctx context.Context, config map[string]string, dir string) error {
	providers := make(map[string]bool)
	for key, value := range config {
		if strings.HasSuffix(key, "_PRIMARY") || strings.HasSuffix(key, "_FAILOVER") {
			for provider := range strings.SplitSeq(value, ",") {
				if runnerID.MatchString(provider) {
					providers[provider] = true
				}
			}
		}
	}
	names := make([]string, 0, len(providers))
	for name := range providers {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		switch name {
		case "codex", "claude", "kimi", "qwen":
			result := host.RunProcess(ctx, host.Process{
				Path: name, Args: []string{"--version"}, Dir: dir, Env: os.Environ(),
				Timeout: 15 * time.Second, Limit: 4096,
			})
			if result.RC != 0 || result.OutputOverflow || len(strings.TrimSpace(string(result.Stdout))) == 0 {
				return fmt.Errorf("host preflight: metadata исполнителя %s недоступны", name)
			}
		default:
			return fmt.Errorf("host preflight: metadata исполнителя %s недоступны", name)
		}
	}
	return nil
}
