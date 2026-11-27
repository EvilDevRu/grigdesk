package menu

import (
	"context"
	"io"
	"os"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"grigdesk.local/tools/shared/i18n"
	"grigdesk.local/tools/utilities/ctl/internal/service"
	"grigdesk.local/tools/utilities/ctl/internal/source"
	"grigdesk.local/tools/utilities/ctl/internal/terminal"
)

type item struct {
	label    string
	argv     []string
	children []item
	prompt   string
	desc     string
	disabled bool
}

type session struct {
	input  terminal.Input
	lang   i18n.CLI
	run    func(context.Context, []string, service.Terminal) int
	term   service.Terminal
	screen terminal.Screen
	header *header
}

type header struct {
	version string
	mode    string
	server  string
	window  string
}

var ansi = regexp.MustCompile(`[\x00-\x09\x0B-\x1F\x7F]`)

const (
	Back = -1
	End  = -2
)

// Run открывает меню с доступными в этой поставке командами.
// Вложенные действия используют тот же экран до завершения всего сеанса.
func Run(ctx context.Context, settings service.Settings, termIO service.Terminal,
	run func(context.Context, []string, service.Terminal) int) int {
	file, ok := termIO.Stdin.(*os.File)
	if !ok {
		return 2
	}
	kind := "source"
	version := source.Version(settings.Root, settings.Version)
	if settings.Portable {
		kind = "portable"
	}
	if settings.Registered != "" {
		kind = "installed"
		version = settings.Version
	}
	headline := &header{
		version: version,
		mode:    kind,
		server:  service.ReadMenuServer(ctx, settings).State,
		window:  service.ReadWindow(settings).State,
	}
	controller := session{
		input: terminal.Input{Ctx: ctx, FD: int(file.Fd()), Out: termIO.Stdout},
		lang:  i18n.CLIForEnvironment(settings.Env), run: run,
		screen: terminal.NewScreen(termIO.Stdout, settings.Env), header: headline,
	}
	termIO.Screen = &controller.screen
	controller.term = termIO
	defer controller.screen.Close()

	items := rootItems()
	if settings.Portable || settings.Registered != "" {
		items = slices.DeleteFunc(items, func(item item) bool {
			return slices.Contains([]string{"build", "development", "dist"}, item.label) ||
				settings.Registered == "remote" && slices.Contains([]string{"server", "relay", "devices"}, item.label) ||
				settings.Registered == "server" && item.label == "open"
		})
	}
	code := controller.choose("question", items, true)
	if code == End {
		return 0
	}
	return code
}

// ConfirmCleanup показывает отчёт вместе с подтверждением и оставляет выбор на отмене.
// PgUp и PgDn позволяют просмотреть все строки перед решением.
func ConfirmCleanup(
	ctx context.Context, settings service.Settings, termIO service.Terminal, report []string,
) (bool, error) {
	file, ok := termIO.Stdin.(*os.File)
	if !ok {
		return false, terminal.Exit(2)
	}
	lang := i18n.CLIForEnvironment(settings.Env)
	input := terminal.Input{Ctx: ctx, FD: int(file.Fd()), Out: termIO.Stdout}
	screen := termIO.Screen
	if screen == nil {
		standalone := terminal.NewScreen(termIO.Stdout, settings.Env)
		screen = &standalone
	}
	choice, err := screen.Choose(input, terminal.Choice{
		Title: lang.Text("cleanup.question"), Details: report,
		Options:    []string{lang.Text("cleanup.cancel"), lang.Text("cleanup.delete")},
		Navigation: lang.Text("navigation"), Paging: lang.Text("cleanup.navigation"),
	})
	return choice == 1, err
}

// rootItems перечисляет доступные команды checkout и запланированные цели.
// Заблокированные платформы видны в меню, но не получают команду сборки.
func rootItems() []item {
	linux := runtime.GOOS == "linux"
	linuxX64 := linux && runtime.GOARCH == "amd64"

	return []item{
		{label: "open", argv: []string{"open"}},
		{label: "status", argv: []string{"status"}},
		{label: "server", desc: "serviceDescription", children: []item{
			{label: "start", argv: []string{"server", "start"}},
			{label: "stop", argv: []string{"server", "stop"}},
			{label: "restart", argv: []string{"server", "restart"}},
			{label: "logs", argv: []string{"server", "logs"}},
		}},
		{label: "relay", desc: "remote.description", children: []item{
			{label: "status", argv: []string{"relay", "status"}},
			{label: "remote.setup", argv: []string{"relay", "setup"}},
			{label: "remote.restore", argv: []string{"relay", "restore"}},
		}},
		{label: "devices", children: []item{
			{label: "add", argv: []string{"device", "add"}, prompt: "namePrompt"},
			{label: "list", argv: []string{"device", "list"}},
			{label: "revoke", argv: []string{"device", "revoke"}, prompt: "idPrompt"},
		}},
		{label: "build", children: []item{
			{label: "all", argv: []string{"build", "all"}},
			{label: "serverOnly", argv: []string{"build", "server"}},
			{label: "web", argv: []string{"build", "web"}},
			{label: "window", argv: []string{"build", "window"}},
			{label: "deepseek", desc: "deepseekDescription", children: []item{
				{label: "deepseekBuild", argv: []string{"build", "deepseek"}},
				{label: "harnessAdmission.action", argv: []string{"build", "deepseek-admission"}},
			}},
			{label: "apk", argv: []string{"build", "apk"}},
		}},
		{label: "development", children: []item{
			{label: "dev", argv: []string{"dev"}},
			{label: "deps", argv: []string{"deps"}},
			{label: "run", argv: []string{"run"}},
		}},
		{label: "artifactsCleanup", argv: []string{"artifacts-cleanup"}},
		{label: "dist", children: []item{
			{
				label:    "distribution.linuxX64",
				argv:     []string{"dist", "build", "--target", "linux-x64", "--channel", "dev"},
				disabled: !linuxX64,
			},
			{
				label:    "distribution.windowsX64",
				argv:     []string{"dist", "build", "--target", "windows-x64", "--channel", "dev"},
				disabled: !linuxX64,
			},
			{label: "distribution.android", argv: []string{"build", "apk"}, disabled: !linux},
			{label: "distribution.macos", disabled: true},
			{label: "distribution.linuxArm64", disabled: true},
			{label: "distribution.windowsArm64", disabled: true},
			{label: "distribution.doctor", argv: []string{"dist", "doctor"}},
		}},
		{label: "exit"},
	}
}

// choose сохраняет активный пункт при возврате из дочернего меню или действия.
// Штатный выход из действия возвращает к этому уровню выбора.
func (ui *session) choose(title string, items []item, root bool) int {
	selected := 0
	for {
		choice, err := ui.input.Select(terminal.Selection{
			Count: len(items), Current: selected,
			Draw: func(columns, rows, selected, _ int) int {
				columns = min(columns, 80)
				ui.screen.Draw(ui.layout(title, items, selected, root, columns, rows), columns, rows)
				return 0
			},
		})
		if err != nil {
			if err == terminal.EndOfInput {
				return End
			}
			return menuExit(err)
		}
		selected = choice
		current := items[choice]
		if current.disabled {
			continue
		}
		if len(current.children) > 0 {
			if code := ui.choose(current.label, current.children, false); code != 0 {
				return code
			}
			continue
		}
		if len(current.argv) == 0 {
			return 0
		}
		label := ui.lang.Text(current.label)
		args := current.argv
		if ui.screen.Positioned() && usesActivity(args[0]) {
			action := ui.lang.Text(title) + " › " + label
			switch code := ui.activity(action, args); code {
			case Back:
				continue
			default:
				return code
			}
		}
		columns, rows := terminal.Size(ui.input.FD)
		ui.screen.Draw([]terminal.Row{terminal.Line("GrigDesk · "+label, terminal.Accent)}, columns, rows)
		ui.screen.ShowCursor()
		if current.prompt != "" {
			label := ui.screen.Label(ui.lang.Text(current.prompt), terminal.Accent)
			value, err := ui.input.Text(label+" ", false, nil, 4096)
			if err == terminal.EndOfInput {
				return End
			}
			if code := menuExit(err); code != 0 {
				return code
			}
			value = strings.TrimSpace(value)
			if value == "" || ansi.MatchString(value) {
				continue
			}
			args = append(append([]string{}, args...), value)
		}
		code := ui.run(ui.input.Ctx, args, ui.term)
		switch code {
		case Back:
			continue
		case End:
			return End
		}
		if ui.input.Ctx.Err() != nil {
			return 130
		}
		if code == 130 || code == 143 {
			cancelled := ui.screen.Label(ui.lang.Text("screens.cancelled"), terminal.Warning)
			_, _ = io.WriteString(ui.term.Stdout, "\n"+cancelled+"\n")
		}
		_, err = ui.input.Text(ui.screen.Label(ui.lang.Text("continue"), terminal.Muted)+" ", true, nil, 0)
		if err == terminal.EndOfInput {
			return End
		}
		if code := menuExit(err); code != 0 {
			return code
		}
	}
}

func usesActivity(command string) bool {
	return slices.Contains([]string{"build", "dist", "dev", "deps", "run"}, command)
}

// activity передаёт команде захваченный поток и оставляет клавиатуру интерфейсу.
// После результата выбор продолжается из того же пункта меню.
func (ui *session) activity(label string, args []string) int {
	labels := terminal.ActivityLabels{
		Title: "GrigDesk · " + label, Running: ui.lang.Text("screens.running"),
		Stopping: ui.lang.Text("screens.stopping"), Cancelled: ui.lang.Text("screens.cancelled"),
		Done: ui.lang.Text("screens.done"), Failed: ui.lang.Text("screens.failed"),
		Cancel: ui.lang.Text("screens.cancel"), Navigation: ui.lang.Text("screens.resultNavigation"),
	}
	err := ui.screen.RunActivity(ui.input, labels, func(ctx context.Context, output io.Writer,
		choose terminal.ChooseFunc) int {
		return ui.run(ctx, args, service.Terminal{Stdout: output, Stderr: output, Screen: &ui.screen, Choose: choose})
	})
	switch err {
	case terminal.EndOfInput:
		return End
	case terminal.Exit(130):
		return 130
	default:
		return Back
	}
}

func menuExit(err error) int {
	if err == terminal.Exit(130) {
		return 130
	}
	return 0
}
