package menu

import (
	"context"
	"fmt"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
	"golang.org/x/term"

	"grigdesk.local/tools/shared/i18n"
	"grigdesk.local/tools/utilities/ctl/internal/service"
	"grigdesk.local/tools/utilities/ctl/internal/source"
)

type item struct {
	label    string
	argv     []string
	children []item
	prompt   string
	desc     string
}

type session struct {
	ctx    context.Context
	in     *os.File
	out    io.Writer
	lang   i18n.CLI
	run    func([]string) int
	color  bool
	header *header
}

type header struct {
	version string
	mode    string
	server  string
	window  string
}

var ansi = regexp.MustCompile(`[\x00-\x09\x0B-\x1F\x7F]`)

// Run управляет выбором и возвращает исходный режим TTY до запуска любой команды.
func Run(ctx context.Context, settings service.Settings, termIO service.Terminal, run func([]string) int) int {
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
		ctx: ctx, in: file, out: termIO.Stdout, lang: i18n.CLIForEnvironment(settings.Env), run: run,
		color: settings.Env["TERM"] != "dumb", header: headline,
	}
	items := rootItems()
	if settings.Portable || settings.Registered != "" {
		items = slices.DeleteFunc(items, func(item item) bool {
			return slices.Contains([]string{"build", "development", "dist"}, item.label) ||
				settings.Registered == "remote" && slices.Contains([]string{"server", "relay", "devices"}, item.label) ||
				settings.Registered == "server" && item.label == "open"
		})
	}
	return controller.choose("question", items, true)
}

// ConfirmCleanup открывает подтверждение с выбранной по умолчанию отменой.
func ConfirmCleanup(ctx context.Context, settings service.Settings, terminal service.Terminal) bool {
	file, ok := terminal.Stdin.(*os.File)
	if !ok {
		return false
	}
	ui := session{ctx: ctx, in: file, out: terminal.Stdout, lang: i18n.CLIForEnvironment(settings.Env)}
	choice, _ := ui.selectItem("cleanup.question", []item{
		{label: "cleanup.cancel"},
		{label: "cleanup.delete"},
	}, 0, false)
	return choice == 1
}

func rootItems() []item {
	return []item{
		{label: "open", argv: []string{"open"}},
		{label: "status", argv: []string{"status"}},
		{label: "server", desc: "serviceDescription", children: []item{
			{label: "start", argv: []string{"server", "start"}},
			{label: "stop", argv: []string{"server", "stop"}},
			{label: "restart", argv: []string{"server", "restart"}},
			{label: "logs", argv: []string{"server", "logs"}},
		}},
		{label: "relay", children: []item{
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
			{label: "deepseek", argv: []string{"build", "deepseek"}},
			{label: "apk", argv: []string{"build", "apk"}},
		}},
		{label: "development", children: []item{
			{label: "dev", argv: []string{"dev"}},
			{label: "deps", argv: []string{"deps"}},
			{label: "run", argv: []string{"run"}},
		}},
		{label: "artifactsCleanup", argv: []string{"artifacts-cleanup"}},
		{label: "dist", children: []item{
			{label: "distribution.build", argv: []string{"dist", "build", "--channel", "dev"}},
			{label: "distribution.doctor", argv: []string{"dist", "doctor"}},
		}},
		{label: "exit"},
	}
}

func (ui session) choose(title string, items []item, root bool) int {
	selected := 0
	for {
		choice, rc := ui.selectItem(title, items, selected, root)
		if choice < 0 {
			return rc
		}
		selected = choice
		current := items[choice]
		if len(current.children) > 0 {
			if code := ui.choose(current.label, current.children, false); code != 0 {
				return code
			}
			continue
		}
		if len(current.argv) == 0 {
			return 0
		}
		args := current.argv
		if current.prompt != "" {
			_, _ = fmt.Fprintln(ui.out, ui.lang.Text(current.prompt))
			value, status := ui.prompt()
			if status == 130 {
				return status
			}
			if value == "" || ansi.MatchString(value) {
				continue
			}
			args = append(append([]string{}, args...), value)
		}
		code := ui.run(args)
		if args[0] == "open" || args[0] == "dev" || args[0] == "run" ||
			code != 0 && args[0] == "build" || code == 130 || code == 143 {
			return code
		}
		_, _ = fmt.Fprintln(ui.out, ui.lang.Text("continue"))
		if ui.waitResult() == 130 {
			return 130
		}
	}
}

func (ui session) selectItem(title string, items []item, selected int, root bool) (int, int) {
	fd := int(ui.in.Fd())
	raw, err := term.MakeRaw(fd)
	if err != nil {
		return -1, 2
	}
	defer term.Restore(fd, raw)
	width, _, _ := term.GetSize(fd)
	ui.render(title, items, selected, root, width)
	for {
		change := true
		switch ui.key() {
		case "down":
			selected = (selected + 1) % len(items)
		case "up":
			selected = (selected + len(items) - 1) % len(items)
		case "enter":
			return selected, 0
		case "interrupt":
			return -1, 130
		case "escape":
			return -1, 0
		default:
			change = false
		}
		currentWidth, _, _ := term.GetSize(fd)
		if change || currentWidth != width {
			width = currentWidth
			ui.render(title, items, selected, root, width)
		}
	}
}

func (ui session) render(title string, items []item, selected int, root bool, width int) {
	if ui.color {
		_, _ = io.WriteString(ui.out, "\x1b[H\x1b[J")
	}
	line := func(text string) {
		visible := []rune(text)
		if width > 0 && len(visible) > width {
			visible = append(visible[:width-1], '…')
		}
		_, _ = fmt.Fprint(ui.out, string(visible), "\r\n")
	}
	if ui.header != nil {
		line(strings.TrimSpace("GrigDesk "+ui.header.version) + " · " + ui.lang.Text(ui.header.mode))
		line(ui.lang.Text("server") + " · " + ui.lang.Text("states."+ui.header.server))
		window := strings.NewReplacer("{marker}", "·", "{state}", ui.lang.Text("states."+ui.header.window))
		line(window.Replace(ui.lang.Text("menuWindowState")))
	}
	line(ui.lang.Text(title))
	if title == "build" {
		line(ui.lang.Text("buildDescription"))
	}
	for index, value := range items {
		if root && index == 0 {
			line(ui.lang.Text("menuGroups.application"))
		} else if root && index == 5 {
			line(ui.lang.Text("menuGroups.developer"))
		}
		marker := "  "
		if index == selected {
			marker = "› "
		}
		line(marker + ui.lang.Text(value.label))
	}
	selection := items[selected]
	description := selection.desc
	if description == "" {
		description = selection.label + "Description"
	}
	if text := ui.lang.Text(description); text != description {
		line(text)
	}
	navigation := "navigation"
	if root {
		navigation = "rootNavigation"
	}
	if width > 0 && width < 48 {
		navigation = "compact" + strings.ToUpper(navigation[:1]) + navigation[1:]
	}
	line(ui.lang.Text(navigation))
}

func (ui session) waitResult() int {
	fd := int(ui.in.Fd())
	raw, err := term.MakeRaw(fd)
	if err != nil {
		return 0
	}
	defer term.Restore(fd, raw)
	for {
		switch ui.key() {
		case "interrupt":
			return 130
		case "enter", "escape":
			return 0
		}
	}
}

func (ui session) key() string {
	fd := int(ui.in.Fd())
	for ui.ctx.Err() == nil {
		value, available := input(fd, 150)
		if !available {
			return ""
		}
		switch value {
		case '\r', '\n':
			return "enter"
		case 3:
			return "interrupt"
		case 4, 'q', 0:
			return "escape"
		case 27:
			if next, ok := input(fd, 35); ok && next == '[' {
				switch tail, _ := input(fd, 35); tail {
				case 'A':
					return "up"
				case 'B':
					return "down"
				}
			}
			return "escape"
		case '\t', 'j':
			return "down"
		case 'k':
			return "up"
		}
	}
	return "interrupt"
}

func input(fd, milliseconds int) (byte, bool) {
	poll := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	ready, err := unix.Poll(poll, milliseconds)
	if err != nil || ready == 0 {
		return 0, false
	}
	var byteValue [1]byte
	n, err := unix.Read(fd, byteValue[:])
	if err != nil || n == 0 {
		return 0, true
	}
	return byteValue[0], true
}

func (ui session) prompt() (string, int) {
	fd := int(ui.in.Fd())
	raw, err := term.MakeRaw(fd)
	if err != nil {
		return "", 0
	}
	defer term.Restore(fd, raw)
	var bytes []byte
	for ui.ctx.Err() == nil {
		value, available := input(fd, 150)
		if !available {
			continue
		}
		switch value {
		case 0, 4, 27:
			_, _ = io.WriteString(ui.out, "\r\n")
			return "", 0
		case 3:
			return "", 130
		case '\n', '\r':
			_, _ = io.WriteString(ui.out, "\r\n")
			return strings.TrimSpace(string(bytes)), 0
		case 8, 127:
			if len(bytes) > 0 {
				_, size := utf8.DecodeLastRune(bytes)
				bytes = bytes[:len(bytes)-size]
				_, _ = io.WriteString(ui.out, "\b \b")
			}
		default:
			if value >= 32 && len(bytes) < 4096 {
				bytes = append(bytes, value)
				_, _ = ui.out.Write([]byte{value})
			}
		}
	}
	return "", 130
}
