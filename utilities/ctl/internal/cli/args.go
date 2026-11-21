package cli

import (
	"fmt"
	"slices"
	"strconv"
	"strings"

	"grigdesk.local/tools/utilities/ctl/internal/service"
)

type arguments struct {
	kind   string
	action service.Action
	tail   []string
	json   bool
	force  bool
}

const hint = "Справка: grigdesk-ctl --help"

var delegated = []string{"desktop", "tracker", "pipeline", "voice", "mobile", "release", "dist"}

func parse(argv []string) (arguments, error) {
	args := arguments{action: service.Action{Lines: 100}}
	if len(argv) == 0 {
		args.kind = "menu"
		return args, nil
	}

	args.kind = argv[0]
	args.tail = argv[1:]
	if slices.Contains(delegated, args.kind) {
		return args, nil
	}
	if args.kind == "help" || slices.Contains(argv, "--help") || slices.Contains(argv, "-h") {
		args.kind = "help"
		return args, nil
	}

	switch args.kind {
	case "build":
		if len(args.tail) <= 1 && (len(args.tail) == 0 ||
			slices.Contains([]string{"all", "server", "web", "window", "factory", "deepseek", "apk"}, args.tail[0])) {
			return args, nil
		}
		const buildUsage = "Укажите цель: grigdesk-ctl build [all|server|web|window|factory|deepseek|apk]. %s"
		return arguments{}, fmt.Errorf(buildUsage, hint)
	case "dev", "deps", "run":
		if len(args.tail) != 0 {
			return arguments{}, fmt.Errorf("Лишний аргумент: %s. %s", args.tail[0], hint)
		}
		return args, nil
	case "recover-update":
		if (len(args.tail) == 2 || len(args.tail) == 3 && args.tail[2] == "--json") &&
			args.tail[0] == "--job" && args.tail[1] != "" {
			return args, nil
		}
		return arguments{}, fmt.Errorf("Укажите задание: grigdesk-ctl recover-update --job <uuid> [--json]")
	case "artifacts-cleanup", "device":
		return args, nil
	case "open", "status":
	case "server", "relay":
		if len(args.tail) == 0 {
			actions := "start | stop | restart | status | logs"
			if args.kind == "relay" {
				actions = "status | setup | restore"
			}
			return arguments{}, fmt.Errorf("Не указано действие: grigdesk-ctl %s %s", args.kind, actions)
		}
		args.action.Name = args.tail[0]
		args.tail = args.tail[1:]
		allowed := []string{"status", "setup", "restore"}
		if args.kind == "server" {
			allowed = []string{"start", "stop", "restart", "status", "logs",
				"check-updates", "update", "update-status", "resume-update", "update-channel"}
		}
		if !slices.Contains(allowed, args.action.Name) {
			return arguments{}, fmt.Errorf("Неизвестная команда: %s %s. %s", args.kind, args.action.Name, hint)
		}
		if args.kind == "server" && slices.Contains(args.tail, "--rollback") {
			return arguments{}, fmt.Errorf("Неизвестный флаг: --rollback. %s", hint)
		}
		if slices.Contains([]string{"setup", "restore", "update", "check-updates", "update-status", "resume-update",
			"update-channel"}, args.action.Name) {
			return args, nil
		}
	default:
		return arguments{}, fmt.Errorf("Неизвестная команда: %s. %s", args.kind, hint)
	}

	for index := 0; index < len(args.tail); index++ {
		flag := args.tail[index]
		switch {
		case flag == "--json" && (args.kind == "status" || args.action.Name == "status"):
			args.json = true
		case flag == "--force" && (args.kind == "open" ||
			args.kind == "server" && (args.action.Name == "stop" || args.action.Name == "restart")):
			args.force = true
		case flag == "--wait" && args.kind == "server" && (args.action.Name == "start" || args.action.Name == "restart"):
			args.action.Wait = true
		case (flag == "-f" || flag == "--follow") && args.action.Name == "logs":
			args.action.Follow = true
		case (flag == "-n" || flag == "--lines") && args.action.Name == "logs":
			index++
			if index == len(args.tail) {
				return arguments{}, fmt.Errorf("Число строк должно быть целым от 1 до 10000")
			}
			lines, err := strconv.Atoi(args.tail[index])
			if err != nil || lines < 1 || lines > 10000 || strings.HasPrefix(args.tail[index], "+") {
				return arguments{}, fmt.Errorf("Число строк должно быть целым от 1 до 10000")
			}
			args.action.Lines = lines
		case strings.HasPrefix(flag, "-"):
			return arguments{}, fmt.Errorf("Неизвестный флаг: %s. %s", flag, hint)
		default:
			return arguments{}, fmt.Errorf("Неизвестная команда: лишний аргумент %s. %s", flag, hint)
		}
	}
	return args, nil
}

func (args arguments) guarded() bool {
	return args.kind == "open" || args.kind == "server" &&
		(args.action.Name == "stop" || args.action.Name == "restart")
}
