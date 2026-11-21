package cli

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/tracker/internal/task"
)

// parseArgs выделяет одну цель из любой позиции до буквального разделителя --.
// Команды без целевой доски отвергают даже один явно переданный --board.
func parseArgs(argv []string) (task.Command, error) {
	args := make([]string, 0, len(argv))
	board := ""
	for index := 0; index < len(argv); index++ {
		value := argv[index]
		if value == "--" {
			args = append(args, argv[index+1:]...)
			break
		}
		if value != "--board" {
			args = append(args, value)
			continue
		}

		index++
		if board != "" || index == len(argv) || strings.HasPrefix(argv[index], "--") ||
			localapi.TrimSpace(argv[index]) == "" {
			return task.Command{}, errors.New("Укажите --board один раз с непустым ID доски.")
		}
		board = argv[index]
	}

	command, err := parseCommand(args)
	if err != nil {
		return task.Command{}, err
	}
	withoutBoard := []string{"--help", "-h", "--version", "--license", "boards"}
	if board != "" && slices.Contains(withoutBoard, command.Kind) {
		return task.Command{}, errors.New("У этой команды нет целевой доски.")
	}
	command.Board = board
	return command, nil
}

// parseCommand проверяет число аргументов до чтения конфигурации или stdin.
// У локальных флагов и команд без параметров хвост всегда отсутствует.
func parseCommand(args []string) (task.Command, error) {
	if len(args) == 0 {
		return task.Command{}, errors.New("Не указана команда.")
	}
	kind, rest := args[0], args[1:]
	command := task.Command{Kind: kind}

	switch kind {
	case "--help", "-h", "--version", "--license", "dashboard", "boards", "create":
		return command, expectCount(kind, rest, 0)
	case "users":
		if len(rest) > 1 {
			return task.Command{}, errors.New("Команда users принимает не больше одного запроса; " +
				"слова возьмите в кавычки.")
		}
		command.Value = strings.Join(rest, "")
		return command, nil
	case "task", "comment", "timer", "start", "complete", "renew", "analyze", "launch-options", "launch":
		return parseTaskCommand(command, rest)
	default:
		return task.Command{}, errors.New("Неизвестная команда.")
	}
}

// parseTaskCommand оставляет ID и текст в том виде, в котором их получил argv.
// У comment пробелы между отдельными аргументами добавляются только при склейке текста.
func parseTaskCommand(command task.Command, rest []string) (task.Command, error) {
	switch command.Kind {
	case "comment":
		if len(rest) < 2 {
			return task.Command{}, errors.New("Команде comment нужны ID и текст комментария.")
		}
		command.Value = strings.Join(rest[1:], " ")
	case "timer":
		if err := expectCount(command.Kind, rest, 2); err != nil {
			return task.Command{}, err
		}
		if !slices.Contains([]string{"start", "pause", "stop"}, rest[1]) {
			return task.Command{}, errors.New("Действие таймера: start, pause или stop.")
		}
		command.Value = rest[1]
	default:
		if err := expectCount(command.Kind, rest, 1); err != nil {
			return task.Command{}, err
		}
	}

	if rest[0] == "" {
		return task.Command{}, fmt.Errorf("Не указан ID задачи у команды %s.", command.Kind)
	}
	command.ID = rest[0]
	return command, nil
}

// expectCount сохраняет разные причины для недостающего и лишнего аргумента.
// Текст диагностики содержит только известное имя команды.
func expectCount(kind string, rest []string, count int) error {
	if len(rest) > count {
		return fmt.Errorf("Лишние аргументы у команды %s.", kind)
	}
	if len(rest) < count {
		return fmt.Errorf("Не хватает аргументов у команды %s.", kind)
	}
	return nil
}
