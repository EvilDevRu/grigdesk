package source

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"grigdesk.local/tools/shared/i18n"
	"grigdesk.local/tools/utilities/ctl/internal/service"
	ctlterm "grigdesk.local/tools/utilities/ctl/internal/terminal"
)

type builder struct {
	settings      service.Settings
	term          service.Terminal
	events        *os.File
	log           *buildLog
	progress      *ctlterm.Progress
	lang          i18n.CLI
	progressMu    sync.Mutex
	activeSteps   []string
	finishedSteps int
	totalSteps    int
	screen        bool
	target        string
}

type stageTiming struct {
	ID         string `json:"id"`
	DurationMS int64  `json:"durationMs"`
}

type buildHistory struct {
	Version  int                      `json:"version"`
	Variants map[string][]stageTiming `json:"variants"`
}

// Build оставляет полный поток команд в журнале и показывает стадию в терминале.
// В потоковом режиме сохраняются исходные команды и события fd 3.
func Build(ctx context.Context, settings service.Settings, target string, screen bool, term service.Terminal) int {
	if target == "" {
		target = "all"
	}
	runner := &builder{settings: settings, term: term, target: target, screen: screen}
	if settings.Env["GRIGDESK_CTL_BUILD_OBSERVED"] == "1" {
		fd := os.NewFile(3, "build-events")
		if _, err := fd.Stat(); err == nil {
			runner.events = fd
		}
	}
	if screen {
		log, err := openBuildLog(settings)
		if err != nil {
			return term.Fail("Не удалось открыть журнал сборки: "+err.Error(), 1)
		}
		defer log.Close()
		runner.log = log
		runner.lang = i18n.CLIForEnvironment(settings.Env)
		runner.progress = ctlterm.NewProgress(term.Stderr, settings.Env, true)
		runner.totalSteps = buildStageCount(target)
		defer runner.progress.Close()
		if term.Screen == nil || !term.Screen.Positioned() {
			console := ctlterm.NewScreen(term.Stdout, settings.Env)
			title := runner.lang.Text("build") + " GrigDesk · " + target
			terminalWrite(term.Stdout, console.Label(title, ctlterm.Accent)+"\n")
		}
		terminalWrite(term.Stdout, logLabel(runner.lang, log.Name)+"\n")
		runner.progress.Update(runner.lang.Text("preparing"), "", 0, runner.totalSteps)
	}
	rc := runner.run(ctx)
	if ctx.Err() != nil {
		rc = 130
	}
	runner.progress.Close()
	if runner.log != nil {
		runner.log.Finish(target, rc)
		if rc == 0 {
			console := ctlterm.NewScreen(term.Stdout, settings.Env)
			terminalWrite(term.Stdout, console.Label(runner.lang.Text("buildDone"), ctlterm.Success)+"\n")
		} else {
			console := ctlterm.NewScreen(term.Stderr, settings.Env)
			failure := strings.NewReplacer("{code}", strconv.Itoa(rc), "{log}", logLabel(runner.lang, runner.log.Name)).
				Replace(runner.lang.Text("buildFailed"))
			terminalWrite(term.Stderr, console.Label(failure, ctlterm.Error)+"\n")
			terminalWrite(term.Stderr, runner.log.Tail())
		}
	}
	return rc
}

func logLabel(lang i18n.CLI, path string) string {
	return strings.ReplaceAll(lang.Text("log"), "{path}", service.Printable(path))
}

func terminalWrite(output io.Writer, value string) {
	_, _ = io.WriteString(output, value)
}

func (runner *builder) event(kind, id string, status ...int) {
	if runner.progress != nil && (kind == "start" || kind == "end") {
		runner.showStage(kind, id, status)
	}
	if runner.events == nil {
		return
	}
	line := kind + "\t" + id
	if len(status) > 0 {
		line += "\t" + strconv.Itoa(status[0])
	}
	terminalWrite(runner.events, line+"\n")
}

// buildStageCount учитывает только стадии, известные до запуска выбранной цели.
// Сценарий DeepSeek зависит от допуска и может добавлять повторные сборки.
func buildStageCount(target string) int {
	if runtime.GOOS == "darwin" && target == "all" {
		return 2
	}
	return map[string]int{"apk": 1, "factory": 1, "web": 2, "window": 4, "server": 4, "all": 9}[target]
}

// showStage удерживает на экране активные параллельные стадии до их завершения.
// Ошибка не прибавляет выполненную работу, а 100% относится к общему итогу команды.
func (runner *builder) showStage(kind, id string, status []int) {
	runner.progressMu.Lock()
	defer runner.progressMu.Unlock()
	if kind == "start" {
		runner.activeSteps = append(runner.activeSteps, id)
	} else {
		if index := slices.Index(runner.activeSteps, id); index >= 0 {
			runner.activeSteps = slices.Delete(runner.activeSteps, index, index+1)
		}
		if len(status) != 0 && status[0] == 0 {
			runner.finishedSteps++
		}
	}
	if len(runner.activeSteps) == 0 {
		runner.progress.Line()
		return
	}
	names := make([]string, 0, len(runner.activeSteps))
	for _, active := range runner.activeSteps {
		key := "steps." + active
		label := runner.lang.Text(key)
		if label == key {
			label = active
		}
		names = append(names, label)
	}
	runner.progress.Update(strings.Join(names, " · "), "", runner.finishedSteps, runner.totalSteps)
}

func (runner *builder) execute(ctx context.Context, cwd, command string, argv ...string) *exec.Cmd {
	child := exec.CommandContext(ctx, command, argv...)
	child.Dir = cwd
	child.Env = os.Environ()
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	child.Cancel = func() error {
		err := syscall.Kill(-child.Process.Pid, syscall.SIGTERM)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	child.WaitDelay = 2 * time.Second
	return child
}

// step пишет весь вывод в журнал, а пользователю сообщает текущую стадию.
// События fd 3 и коды дочерней команды сохраняются.
func (runner *builder) step(ctx context.Context, id, cwd, command string, argv ...string) int {
	if id != "" {
		runner.event("start", id)
	}
	start := time.Now()
	child := runner.execute(ctx, cwd, command, argv...)
	child.Stdout, child.Stderr = runner.term.Stdout, runner.term.Stderr
	if runner.log != nil {
		child.Stdout, child.Stderr = runner.log, runner.log
	}
	// Сборка не принимает строки из управляющего терминала.
	err := child.Run()
	rc := service.ExitCode(err)
	if rc != 0 {
		var result *exec.ExitError
		if !errors.As(err, &result) {
			terminalWrite(child.Stderr, service.Printable(err.Error())+"\n")
		}
	}
	if id != "" {
		runner.event("end", id, rc)
	}
	if runner.log != nil && id != "" {
		runner.log.Record(id, time.Since(start))
		if rc != 0 {
			runner.progress.Line()
			terminalWrite(runner.term.Stderr, fmt.Sprintf("Сбой стадии %s (код %d)\n", id, rc))
		}
	}
	return rc
}

func (runner *builder) run(ctx context.Context) int {
	root, target := runner.settings.Root, runner.target
	if runtime.GOOS == "darwin" && target == "all" {
		if code := runner.factory(ctx); code != 0 {
			return code
		}
		return runner.step(ctx, "distribution.build", root, "node",
			filepath.Join(root, "tools", "distribution.mts"), "build", "--channel", "dev")
	}
	switch target {
	case "factory":
		return runner.factory(ctx)
	case "apk":
		return runner.step(ctx, "apk.build", root, filepath.Join(root, "tools", "mobile"), "build")
	case "deepseek":
		return runner.deepseek(ctx)
	case "server":
		if code := runner.dependencies(ctx, false, false); code != 0 {
			return code
		}
		return runner.server(ctx)
	}

	if code := runner.dependencies(ctx, false, true); code != 0 {
		return code
	}
	if target == "all" {
		return runner.all(ctx)
	}
	if code := runner.web(ctx); code != 0 {
		return code
	}
	if target == "web" {
		terminalWrite(runner.term.Stdout, "Собран веб: "+filepath.Join(root, "web", "dist")+"\n")
		terminalWrite(runner.term.Stdout, "Окно покажет новый веб после grigdesk-ctl build window.\n")
		return 0
	}
	if code := runner.packageWindow(ctx); code != 0 {
		return code
	}
	return runner.installWindow(ctx)
}

func (runner *builder) dependencies(ctx context.Context, forceWeb, withWeb bool) (rc int) {
	if withWeb {
		const id = "web.dependencies"
		runner.event("start", id)
		start := time.Now()
		defer func() {
			runner.event("end", id, rc)
			if runner.log != nil {
				runner.log.Record(id, time.Since(start))
			}
		}()
	}
	root := runner.settings.Root
	if code := runner.step(ctx, "", filepath.Join(root, "server"),
		"npm", "install", "--no-audit", "--no-fund"); code != 0 {
		return code
	}
	web := filepath.Join(root, "web")
	if _, err := os.Stat(filepath.Join(web, "node_modules")); withWeb && (forceWeb || err != nil) {
		if code := runner.step(ctx, "", web, "npm", "install", "--no-audit", "--no-fund"); code != 0 {
			return code
		}
	}
	if withWeb {
		server := filepath.Join(root, "server")
		if runner.step(ctx, "", server, "npm", "run", "--silent", "deepseek:prepare") != 0 {
			runner.progress.Line()
			terminalWrite(runner.term.Stderr,
				"DeepSeek недоступен; GrigDesk работает без него. Установите совместимый ELF через install:binary\n")
		}
	}
	return 0
}

func (runner *builder) web(ctx context.Context) int {
	return runner.step(ctx, "web.build", filepath.Join(runner.settings.Root, "web"), "npm", "run", "build")
}

func (runner *builder) packageWindow(ctx context.Context) int {
	root := runner.settings.Root
	return runner.step(ctx, "window.package", root, "npm", "--prefix", filepath.Join(root, "desktop"), "run", "dist")
}

func (runner *builder) installWindow(ctx context.Context) int {
	root := runner.settings.Root
	argv := []string{"install"}
	if runner.target == "all" {
		argv = append(argv, "--keep-runtime")
	}
	if code := runner.step(ctx, "window.install", root, filepath.Join(root, "deploy", "desktop.sh"), argv...); code != 0 {
		return code
	}
	if runner.target == "window" {
		terminalWrite(runner.term.Stdout, "Поставлено окно: "+filepath.Join(root, "bin", "grigdesk-app")+"; веб собран.\n")
	}
	return 0
}

func (runner *builder) chainedWindow(ctx context.Context) int {
	if code := runner.web(ctx); code != 0 {
		return code
	}
	return runner.packageWindow(ctx)
}

func (runner *builder) all(ctx context.Context) int {
	root := runner.settings.Root
	var statuses [3]int
	var group sync.WaitGroup
	operations := []func(context.Context) int{runner.server, runner.chainedWindow, runner.utilities}
	for index, operation := range operations {
		group.Go(func() { statuses[index] = operation(ctx) })
	}
	group.Wait()
	for _, code := range statuses {
		if code != 0 {
			return code
		}
	}
	if code := runner.installWindow(ctx); code != 0 {
		return code
	}
	selectServer := runner.execute(ctx, root, "node", filepath.Join(root, "server", "scripts", "ctlBuild.mts"),
		"queue-desktop", filepath.Join(root, "bin", "grigdesk-server"))
	answer, err := selectServer.Output()
	if err != nil {
		return service.ExitCode(err)
	}
	switch strings.TrimSpace(string(answer)) {
	case "queued":
		runner.event("hint", "queued-server")
		terminalWrite(runner.term.Stdout, "При следующем запуске окно выберет сервер этой сборки.\n")
	case "foreign":
		runner.selectServerHint()
	case "current":
	default:
		return runner.term.Fail("Не удалось определить привязку окна после полной установки.", 1)
	}
	return runner.term.Say("Поставлены сервер, веб, окно и утилиты Go.")
}

func (runner *builder) utilities(ctx context.Context) int {
	root := runner.settings.Root
	output := filepath.Join(root, "bin", "utilities")
	return runner.step(ctx, "utilities.build", root, "bash", filepath.Join(root, "tools", "build-go-utilities.sh"), output)
}

// factory использует один сборщик для отдельной цели и серверной цепочки.
// Публикация кандидата не меняет runtime работающего сервера.
func (runner *builder) factory(ctx context.Context) int {
	root := runner.settings.Root
	tool := filepath.Join(root, "tools", "build-factory.sh")
	return runner.step(ctx, "factory.build", root, "bash", tool, filepath.Join(root, "bin"))
}

func (runner *builder) server(ctx context.Context) int {
	if code := runner.factory(ctx); code != 0 {
		return code
	}
	root := runner.settings.Root
	data := runner.settings.DataHome
	cacheDir := runner.settings.Env["XDG_CACHE_HOME"]
	if cacheDir == "" {
		cacheDir = filepath.Join(runner.settings.Home, ".cache")
	}
	cache := filepath.Join(cacheDir, "grigdesk", "server-binary")
	tool := filepath.Join(root, "server", "scripts", "ctlBuild.mts")
	modeCommand := runner.execute(ctx, root, "node", tool, "glm-mode", filepath.Join(data, ".env"))
	mode, err := modeCommand.Output()
	if err != nil {
		return service.ExitCode(err)
	}
	if code := runner.step(ctx, "server.node", root, "node", tool, "prepare-runtime", filepath.Join(cache, "cache")); code != 0 {
		return code
	}
	server := filepath.Join(root, "server")
	build := []string{"--prefix", server, "run", "build:binary", "--",
		"--out-dir", filepath.Join(cache, "out"), "--cache-dir", filepath.Join(cache, "cache")}
	if runtime.GOOS == "linux" && runtime.GOARCH == "amd64" {
		build = append(build, "--factory-candidate", filepath.Join(root, "bin", "factory"))
	}
	if code := runner.step(ctx, "server.build", root, "npm", build...); code != 0 {
		return code
	}
	target := filepath.Join(root, "bin", "grigdesk-server")
	arguments := []string{"--prefix", server, "run", "install:binary", "--",
		"--binary", filepath.Join(cache, "out", "grigdesk-server"), "--target", target,
		"--releases-dir", filepath.Join(data, "runtimes", "server", "releases"),
		"--glm-mode", strings.TrimSpace(string(mode))}
	if worker := runner.settings.Env["GRIGDESK_DEEPSEEK_BIN"]; worker != "" {
		arguments = append(arguments, "--deepseek-binary", worker)
	}
	if code := runner.step(ctx, "server.install", root, "npm", arguments...); code != 0 {
		return code
	}
	if runner.target != "all" {
		probe := runner.execute(ctx, root, "node", tool, "check-desktop", target)
		if err := probe.Run(); err != nil {
			runner.selectServerHint()
		}
		terminalWrite(runner.term.Stdout, "Поставлен сервер: "+target+"\n")
	}
	return 0
}

func (runner *builder) selectServerHint() {
	runner.event("hint", "select-server")
	terminalWrite(runner.term.Stdout, fmt.Sprintf("Для выбора этого сервера окном: grigdesk-ctl desktop use-server %q\n",
		filepath.Join(runner.settings.Root, "bin", "grigdesk-server")))
}

func (runner *builder) deepseek(ctx context.Context) int {
	root := runner.settings.Root
	directory := filepath.Join(root, "deepseek")
	data := runner.settings.DataHome
	cache := runner.settings.Env["XDG_CACHE_HOME"]
	if cache == "" {
		cache = filepath.Join(runner.settings.Home, ".cache")
	}
	cache = filepath.Join(cache, "grigdesk", "deepseek-binary")
	nodeCache := filepath.Join(cache, "cache")
	out := filepath.Join(cache, "out")
	binary := filepath.Join(out, "deepseek")
	host := filepath.Join(root, "server", "deepseek-host-contract.json")
	helper := filepath.Join(root, "server", "scripts", "ctlBuild.mts")
	modeCommand := runner.execute(ctx, root, "node", helper, "glm-mode", filepath.Join(data, ".env"))
	mode, err := modeCommand.Output()
	if err != nil {
		return service.ExitCode(err)
	}
	glm := strings.TrimSpace(string(mode))
	if glm != "api" && glm != "coding-plan" {
		return runner.term.Fail("Неверный режим допуска DeepSeek.", 1)
	}
	step := func(id string, args ...string) int {
		return runner.step(ctx, "deepseek."+id, root, "npm", append([]string{"--prefix", directory}, args...)...)
	}
	if _, err := os.Stat(filepath.Join(directory, "node_modules")); err != nil {
		if code := step("deps", "install", "--no-audit", "--no-fund"); code != 0 {
			return code
		}
	} else {
		runner.event("start", "deepseek.deps")
		runner.event("end", "deepseek.deps", 0)
	}
	if code := step("prepare", "run", "--silent", "prepare:runtime", "--", "--node-cache-dir", nodeCache); code != 0 {
		return code
	}
	build := func() int {
		if code := step("build", "run", "build", "--", "--out-dir", out, "--node-cache-dir", nodeCache); code != 0 {
			return code
		}
		return step("verify", "run", "verify", "--", "--binary", binary)
	}
	if code := build(); code != 0 {
		return code
	}
	admission := func(mode string) int {
		return step("admission-"+mode, "run", "--silent", "admission:check", "--",
			"--binary", binary, "--mode", mode, "--host-contract", host)
	}
	smoke := runner.settings.Env["GRIGDESK_DEEPSEEK_SMOKE"]
	for _, mode := range []string{"api", "coding-plan"} {
		wanted := smoke == "both" || smoke == "consumer" && mode == glm
		if wanted && admission(mode) != 0 {
			live := filepath.Join(root, "server", "scripts", "glmLiveSmoke.mts")
			if code := runner.step(ctx, "deepseek.smoke-"+mode, root, "env", "GRIGDESK_HOME="+data,
				"node", live, "--mode", mode, "--confirm-live", "--binary", binary,
				"--cache-dir", filepath.Join(cache, "smoke"), "--admit"); code != 0 {
				return code
			}
			if code := build(); code != 0 {
				return code
			}
		} else {
			for _, id := range []string{"admission-", "smoke-"} {
				runner.event("start", "deepseek."+id+mode)
				runner.event("end", "deepseek."+id+mode, 0)
			}
		}
	}
	if admission(glm) != 0 {
		runner.event("hint", "deepseek-deferred")
		runner.term.Say("DeepSeek собран и проверен: " + binary)
		runner.term.Say("Установка не выполнена: не хватает живого допуска GLM (" + glm + ").")
		return 0
	}
	target := filepath.Join(root, "bin", "deepseek")
	releases := filepath.Join(data, "runtimes", "deepseek", "releases")
	if code := step("install", "run", "--silent", "install:binary", "--", "--binary", binary,
		"--target", target, "--host-contract", host, "--releases-dir", releases, "--glm-mode", glm); code != 0 {
		runner.term.Fail("DeepSeek собран и проверен: "+binary+"; установка не выполнена.", code)
		return code
	}
	_ = os.Remove(binary)
	if code := step("prune", "run", "--silent", "prune:cache", "--", "--cache-dir", filepath.Dir(releases)); code != 0 {
		runner.term.Fail("Чистка кэша DeepSeek не выполнена; поколения и резервы остаются.", code)
	}
	runner.term.Say("Поставлен DeepSeek: " + target)
	return runner.term.Say("Новый ELF получит следующий ход DeepSeek; перезапуск сервера не нужен.")
}

// Development оставляет npm и Node явными инструментами режима разработки.
func Development(ctx context.Context, settings service.Settings, name string, terminal service.Terminal) int {
	runner := &builder{settings: settings, term: terminal}
	root := settings.Root
	server := filepath.Join(root, "server")
	web := filepath.Join(root, "web")
	var nodeArgs []string
	if name != "deps" {
		helper := filepath.Join(server, "scripts", "dataHomeCheck.mts")
		if code := runner.step(ctx, "", root, "node", helper, "--code-root", root); code != 0 {
			return code
		}
		if _, err := os.Stat(settings.EnvFile); err == nil {
			nodeArgs = append(nodeArgs, "--env-file", settings.EnvFile)
		}
	}
	if name == "run" && PortOpen(ctx, settings.Port) {
		return terminal.Say("→ GrigDesk уже слушает :" + settings.Port + " — открой http://localhost:" + settings.Port)
	}
	if name == "dev" || name == "run" {
		if code := runner.factory(ctx); code != 0 {
			return code
		}
	}
	if code := runner.dependencies(ctx, name == "deps", true); code != 0 {
		return code
	}
	switch name {
	case "deps":
		return 0
	case "dev":
		return runner.dev(ctx, server, web, nodeArgs)
	case "run":
		if code := runner.web(ctx); code != 0 {
			return code
		}
		terminal.Say("→ Сервер поднят: http://localhost:" + settings.Port + " (только с этой машины)")
		args := append(nodeArgs, "src/app.ts")
		if terminal.Screen != nil {
			return runner.step(ctx, "", server, "node", args...)
		}
		return terminal.Fail(Exec(server, "node", args).Error(), 1)
	default:
		return 2
	}
}

func (runner *builder) dev(ctx context.Context, server, web string, nodeArgs []string) int {
	active, stop := context.WithCancel(ctx)
	defer stop()
	vite := runner.execute(active, web, "npm", "run", "dev")
	vite.Stdout, vite.Stderr = runner.term.Stdout, runner.term.Stderr
	if err := vite.Start(); err != nil {
		return runner.term.Fail(err.Error(), 1)
	}
	defer func() {
		stop()
		_ = vite.Wait()
	}()
	runner.term.Say("→ Dev: vite :5180 + сервер (--watch) :" + runner.settings.Port)
	brain := runner.execute(active, server, "node", append(nodeArgs, "--watch", "src/app.ts")...)
	brain.Stdin, brain.Stdout, brain.Stderr = runner.term.Stdin, runner.term.Stdout, runner.term.Stderr
	brain.Env = append(brain.Env, "NODE_ENV=development")
	rc := service.ExitCode(brain.Run())
	if ctx.Err() != nil {
		return 130
	}
	return rc
}
