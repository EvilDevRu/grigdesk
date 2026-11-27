package source

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/ctl/internal/service"
	ctlterm "grigdesk.local/tools/utilities/ctl/internal/terminal"
	"grigdesk.local/tools/utilities/internal/installation"
)

const admissionMissing = 3
const glm54BackportEnv = "GRIGDESK_DEEPSEEK_GLM_54_BACKPORT"

// enableHarnessQuestions подключает локальный ввод для прямой команды.
// В меню выбор уже передан владельцем активного экрана.
func (runner *builder) enableHarnessQuestions(ctx context.Context) {
	if runner.term.Choose != nil || !ctlterm.IsTTY(runner.term.Stdin) || !ctlterm.IsTTY(runner.term.Stdout) {
		return
	}
	file := runner.term.Stdin.(*os.File)
	input := ctlterm.Input{Ctx: ctx, FD: int(file.Fd()), Out: runner.term.Stdout}
	screen := runner.term.Screen
	if screen == nil {
		standalone := ctlterm.NewScreen(runner.term.Stdout, runner.settings.Env)
		screen = &standalone
	}
	runner.term.Choose = func(choice ctlterm.Choice) (int, error) {
		runner.progress.Line()
		return screen.Choose(input, choice)
	}
}

// chooseDeepseekBackport спрашивает о патче до сборки, если его поддерживает закреплённый снимок.
// Результат передаётся дочерним сборщикам без изменения окружения меню и следующих запусков.
func (runner *builder) chooseDeepseekBackport(ctx context.Context, helper, manifest string) (string, int) {
	if value, explicit := runner.settings.Env[glm54BackportEnv]; explicit || runner.term.Choose == nil {
		if value == "1" {
			return "1", 0
		}
		return "0", 0
	}

	command := runner.execute(ctx, runner.settings.Root, "node", helper, "glm54-backport", manifest)
	command.Stderr = runner.term.Stderr
	output, err := command.Output()
	if err != nil {
		return "", service.ExitCode(err)
	}
	if strings.TrimSpace(string(output)) == "0" {
		return "0", 0
	}

	language := runner.lang
	choice, err := runner.term.Choose(ctlterm.Choice{
		Title:   language.Text("harnessBackport.title"),
		Details: []string{language.Text("harnessBackport.details")},
		Options: []string{
			language.Text("harnessBackport.skip"),
			language.Text("harnessBackport.include"),
		},
		Navigation: language.Text("harnessBackport.navigation"),
	})
	switch {
	case err == ctlterm.EndOfInput || err == ctlterm.Exit(130) || err == ctlterm.Exit(2):
		return "", 130
	case err != nil:
		return "", runner.term.Fail(err.Error(), 1)
	case choice == 1:
		return "1", 0
	default:
		return "0", 0
	}
}

// deepseek проверяет собранный кандидат и при необходимости получает допуск GLM.
// Общий путь кандидата остаётся занят до решения пользователя и конца установки.
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
	manifest := filepath.Join(directory, "vendor", "deepseek-harness", "upstream.lock.json")
	backport, code := runner.chooseDeepseekBackport(ctx, helper, manifest)
	if code != 0 {
		return code
	}

	modeCommand := runner.execute(ctx, root, "node", helper, "glm-mode", filepath.Join(data, ".env"))
	mode, err := modeCommand.Output()
	if err != nil {
		return service.ExitCode(err)
	}
	glm := strings.TrimSpace(string(mode))
	if glm != "api" && glm != "coding-plan" {
		return runner.term.Fail(runner.lang.Text("harnessAdmission.invalidMode"), 1)
	}
	if err := os.MkdirAll(cache, 0o700); err != nil {
		return runner.term.Fail(err.Error(), 1)
	}
	release, err := installation.AcquireLock(filepath.Join(cache, "ctl-build.lock"))
	if err != nil {
		message := runner.lang.Text("harnessBuildLock")
		return runner.term.Fail(strings.ReplaceAll(message, "{reason}", err.Error()), 1)
	}
	defer release()

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
	if code := step("prepare", "run", "--silent", "prepare:runtime", "--",
		"--node-cache-dir", nodeCache); code != 0 {
		return code
	}
	build := func() int {
		code := runner.step(ctx, "deepseek.build", root, "env", glm54BackportEnv+"="+backport,
			"npm", "--prefix", directory, "run", "build", "--", "--out-dir", out, "--node-cache-dir", nodeCache)
		if code != 0 {
			return code
		}
		return step("verify", "run", "verify", "--", "--binary", binary)
	}
	if code := build(); code != 0 {
		return code
	}

	admitted, code := runner.admitDeepseek(ctx, binary, host, cache, glm, build)
	if code != 0 {
		return code
	}
	candidate := strings.ReplaceAll(runner.lang.Text("harnessCandidate"), "{path}", binary)
	if !admitted {
		runner.event("hint", "deepseek-deferred")
		runner.term.Say(candidate)
		runner.term.Say(strings.ReplaceAll(runner.lang.Text("deepseekDeferred"), "{mode}", glm))
		return runner.term.Say(runner.lang.Text("harnessDeferredHint"))
	}
	target := filepath.Join(root, "bin", "deepseek")
	releases := filepath.Join(data, "runtimes", "deepseek", "releases")
	if code := step("install", "run", "--silent", "install:binary", "--", "--binary", binary,
		"--target", target, "--host-contract", host, "--releases-dir", releases, "--glm-mode", glm); code != 0 {
		return runner.term.Fail(candidate, code)
	}
	_ = os.Remove(binary)
	if code := step("prune", "run", "--silent", "prune:cache", "--",
		"--cache-dir", filepath.Dir(releases)); code != 0 {
		runner.term.Fail(runner.lang.Text("harnessPruneFailed"), code)
	}
	runner.term.Say(strings.ReplaceAll(runner.lang.Text("summaryDeepseek"), "{path}", target))
	return runner.term.Say(runner.lang.Text("deepseekHint"))
}

// admitDeepseek предлагает живую проверку только для отсутствующего допуска кандидата.
// Проверки режимов независимы, пересборка и повторная проверка ждут их общего успеха.
func (runner *builder) admitDeepseek(
	ctx context.Context, binary, host, cache, glm string, build func() int,
) (bool, int) {
	root := runner.settings.Root
	check := func(mode string) int {
		return runner.runStep(ctx, "deepseek.admission-"+mode, root, admissionMissing,
			"npm", "--prefix", filepath.Join(root, "deepseek"), "run", "--silent", "admission:check", "--",
			"--binary", binary, "--mode", mode, "--host-contract", host)
	}
	status := check(glm)
	if status != 0 && status != admissionMissing {
		return false, status
	}

	var missing []string
	if status == admissionMissing {
		missing = append(missing, glm)
	}
	smoke := runner.settings.Env["GRIGDESK_DEEPSEEK_SMOKE"]
	explicit := runner.target == "deepseek-admission"
	interactive := smoke == "" && runner.term.Choose != nil
	if explicit || smoke == "both" || interactive && status == admissionMissing {
		other := "api"
		if glm == "api" {
			other = "coding-plan"
		}
		switch code := check(other); code {
		case 0:
		case admissionMissing:
			missing = append(missing, other)
		default:
			return false, code
		}
	}
	if len(missing) == 0 {
		if explicit {
			runner.term.Say(runner.lang.Text("harnessAdmission.already"))
		}
		return true, 0
	}

	var wanted []string
	switch {
	case smoke == "both":
		wanted = missing
	case smoke == "consumer" && status == admissionMissing:
		wanted = []string{glm}
	case interactive:
		var code int
		wanted, code = runner.askAdmission(missing, glm)
		if code != 0 {
			return false, code
		}
	}

	if len(wanted) != 0 {
		live := filepath.Join(root, "server", "scripts", "glmLiveSmoke.mts")
		operations := make([]func(context.Context) int, 0, len(wanted))
		for _, mode := range wanted {
			operations = append(operations, func(ctx context.Context) int {
				return runner.step(ctx, "deepseek.smoke-"+mode, root, "env",
					"GRIGDESK_HOME="+runner.settings.DataHome, "node", live,
					"--mode", mode, "--confirm-live", "--binary", binary,
					"--cache-dir", filepath.Join(cache, "smoke"), "--admit")
			})
		}
		if code := parallelSteps(ctx, operations...); code != 0 {
			return false, code
		}
		if code := build(); code != 0 {
			return false, code
		}
	}
	for _, mode := range wanted {
		if code := check(mode); code != 0 {
			message := strings.ReplaceAll(runner.lang.Text("harnessAdmission.verifyFailed"), "{mode}", mode)
			return false, runner.term.Fail(message, code)
		}
	}
	if explicit && status == 0 && len(wanted) == 0 {
		modes := strings.Join(missing, ", ")
		runner.term.Say(strings.ReplaceAll(runner.lang.Text("harnessAdmission.deferred"), "{modes}", modes))
	}
	return status == 0 || slices.Contains(wanted, glm), 0
}

// askAdmission передаёт экрану только режимы, для которых нужна живая проверка.
// Esc откладывает проверку, а Ctrl+C и закрытый ввод отменяют цепочку.
func (runner *builder) askAdmission(missing []string, consumer string) ([]string, int) {
	language := runner.lang
	modes := strings.Join(missing, ", ")
	title := strings.ReplaceAll(language.Text("harnessAdmission.missing"), "{modes}", modes)
	var options []string
	for _, mode := range missing {
		options = append(options, strings.ReplaceAll(language.Text("harnessAdmission.run"), "{mode}", mode))
	}
	if len(missing) > 1 {
		options = append(options, language.Text("smokeMissingChoice.both"))
	}
	deferLabel := "harnessAdmission.defer"
	if slices.Contains(missing, consumer) {
		deferLabel = "smokeMissingChoice.none"
	}
	options = append(options, language.Text(deferLabel))

	index, err := runner.term.Choose(ctlterm.Choice{
		Title: title, Details: []string{language.Text("harnessAdmission.cost")}, Options: options,
		Navigation: language.Text("smokeNavigation"),
	})
	switch {
	case err == ctlterm.EndOfInput || err == ctlterm.Exit(130):
		return nil, 130
	case err == ctlterm.Exit(2):
		return nil, 0
	case err != nil:
		return nil, runner.term.Fail(err.Error(), 1)
	case index == len(options)-1:
		return nil, 0
	case index < len(missing):
		return missing[index : index+1], 0
	default:
		return missing, 0
	}
}
