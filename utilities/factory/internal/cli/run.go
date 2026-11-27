package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/route"
	"grigdesk.local/tools/utilities/factory/internal/runner"
)

const baseCapabilities = `"goto-expected-stage-v1","native-subcommands"`

// Run обрабатывает публичный запрос, начиная с проверки аргументов.
// Описание возможностей доступно серверу без загрузки профиля или состояния.
func Run(args []string, out, diagnostic io.Writer) int {
	if len(args) > 0 && (args[0] == "stage-result" || args[0] == "stage-progress") {
		return runStatus(args[0], args[1:], diagnostic)
	}
	if len(args) > 0 && args[0] == "graph-workflow" {
		return runGraphWorkflow(args[1:], os.Stdin, out, diagnostic)
	}
	if len(args) > 0 && args[0] == "route" {
		return runRoute(args[1:], os.Stdin, out, diagnostic)
	}
	if len(args) > 0 && args[0] == "context" {
		return route.RunContext(args[1:], out, diagnostic)
	}
	if len(args) > 0 && args[0] == "profile-check" {
		return runProfileCheck(args[1:], out, diagnostic)
	}
	if len(args) > 0 && args[0] == "capabilities" {
		if !slices.Equal(args, []string{"capabilities", "--format", "json"}) {
			return fail(diagnostic, fmt.Errorf("capabilities требует --format json"))
		}
		features := baseCapabilities
		if runtime.GOOS == "linux" {
			features += `,"stage-runner-settings-v1","stage-runner-speed-v1"`
		}
		return printLine(out, `{"schema":1,"features":[`+features+`]}`)
	}

	r, err := parseRequest(args)
	if err != nil {
		return fail(diagnostic, err)
	}
	switch r.mode {
	case "help":
		return printLine(out, "Использование: factory [TASK] КОМАНДА --profile PROFILE [опции]")
	case "work-time":
		return workTime(r, out, diagnostic)
	case "lifecycle-read":
		return readLifecycle(r, out, diagnostic)
	case "list":
		return listAttempts(r.stateDir(), out, diagnostic)
	case "slots":
		return slots(r, out, diagnostic)
	case "runners":
		return printLine(out, strings.Join(runner.Providers(), "\n"))
	case "profile":
		if len(args) >= 3 && args[2] == "debug" {
			return debugSettings(r, args[1], args[3:], out, diagnostic)
		}
		return profileRunnerSettings(args[1:], out, diagnostic)
	case "settings":
		if len(args) >= 2 && args[1] == "debug" {
			return debugSettings(r, "", args[2:], out, diagnostic)
		}
		return unavailable(diagnostic)
	case "debug":
		return debugSettings(r, "", args[2:], out, diagnostic)
	case "runner":
		return runTaskRunner(r, args[2:], out, diagnostic)
	case "model":
		return unavailable(diagnostic)
	}
	if err := r.admit(); err != nil {
		return fail(diagnostic, err)
	}
	if r.mode == "findings-export" {
		return exportFindings(r, out, diagnostic)
	}
	if r.mode == "check" && r.task == "" {
		return checkCurrent(r, out, diagnostic)
	}
	if r.mode == "start" || r.mode == "resume" {
		return launchRoute(r, diagnostic)
	}
	if r.mode == "gate" || r.mode == "goto" || r.mode == "abandon" || r.mode == "recover" ||
		r.mode == "bootstrap-answer" {
		return runRouteDecision(r, out, diagnostic)
	}
	return unavailable(diagnostic)
}

func printLine(out io.Writer, value string) int {
	if _, err := fmt.Fprintln(out, value); err != nil {
		return 1
	}
	return 0
}

func fail(diagnostic io.Writer, err error) int {
	fmt.Fprintf(diagnostic, "factory: %s\n", err)
	return 78
}

func unavailable(diagnostic io.Writer) int {
	return fail(diagnostic, fmt.Errorf("команда или формат не поддерживаются"))
}

// slots отвечает на необязательную возможность профиля в прежнем формате.
// Проекты без распределителя используют совместный стенд с пустыми used и free.
func slots(r request, out, diagnostic io.Writer) int {
	profile := r.value("--profile")
	script, _, _ := hooks.ProfileFiles(profile)
	result, rc, err := hooks.ListSlots(context.Background(), profile, script, r.stateDir())
	if err != nil {
		fmt.Fprintf(diagnostic, "factory: %s\n", err)
		return rc
	}
	if result["supported"] == false {
		value := fmt.Sprintf(`{"profile":%q,"supported":false,"used":[],"free":[]}`, profile)
		return printLine(out, value)
	}
	if err := json.NewEncoder(out).Encode(result); err != nil {
		return 1
	}
	return rc
}

// listAttempts читает только текущие проекции в явно выбранном каталоге state.
// Старый RUN_PROTOCOL доступ к попытке не подтверждает и в выдачу не попадает.
func listAttempts(dir string, out, diagnostic io.Writer) int {
	if !filepath.IsAbs(dir) || dir == string(filepath.Separator) ||
		filepath.Clean(dir) != dir || strings.ContainsAny(dir, "\n\t") {
		return fail(diagnostic, fmt.Errorf("state-dir: нужен абсолютный не корневой путь"))
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil || resolved != dir {
		return fail(diagnostic, fmt.Errorf("state-dir: путь должен быть нормализован"))
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return fail(diagnostic, fmt.Errorf("state-dir: %w", err))
	}
	defer root.Close()
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return fail(diagnostic, fmt.Errorf("state-dir: %w", err))
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || !strings.HasPrefix(name, "t") ||
			!strings.HasSuffix(name, ".pipeline") {
			continue
		}
		profile, route, current := readProjection(root, name)
		if current {
			task := strings.TrimSuffix(strings.TrimPrefix(name, "t"), ".pipeline")
			if _, err := fmt.Fprintf(out, "#%s [%s] route=%s\n", task, profile, route); err != nil {
				return 1
			}
		}
	}
	return 0
}

// readProjection сохраняет последнее значение ключей совместимого построчного формата.
// Успешное чтение проекции требуется до добавления строки в список.
func readProjection(root *os.Root, name string) (profile, route string, current bool) {
	file, err := root.Open(name)
	if err != nil {
		return "", "", false
	}
	defer file.Close()

	reader := bufio.NewReader(file)
	var protocol string
	for {
		line, err := reader.ReadString('\n')
		key, value, _ := strings.Cut(strings.TrimSuffix(line, "\n"), "=")
		value, _, _ = strings.Cut(value, "=")
		switch key {
		case "PROFILE":
			profile = value
		case "ROUTE":
			route = value
		case "CATALOG_PROTOCOL":
			protocol = value
		}
		if err != nil {
			return profile, route, err == io.EOF && protocol == "route-v2"
		}
	}
}
