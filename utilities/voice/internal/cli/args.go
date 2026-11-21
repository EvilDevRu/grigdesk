package cli

import (
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

type options struct {
	name   string
	values map[string]string
	engine string
	json   bool
}

var subcommands = []string{"help", "version", "engines", "models", "voices", "generate", "install"}
var engines = []string{"qwen", "piper", "silero"}

// parse проверяет один закрытый набор флагов для выбранной команды.
// Текст не попадает в ошибки аргументов, а повтор флага не переписывает первую цель.
func parse(args []string) (options, error) {
	name := "help"
	if len(args) > 0 {
		name, args = args[0], args[1:]
	}
	if name == "--help" || name == "-h" {
		name = "help"
	}
	if !slices.Contains(subcommands, name) {
		return options{}, voicecore.Usage("неизвестная команда; выполните voice help")
	}
	result := options{name: name, values: make(map[string]string)}
	allowed := []string{"--api-key", "--dir", "--json", "--service"}
	if name == "voices" {
		allowed = append(allowed, "--engine")
	}
	if name == "generate" {
		allowed = append(allowed, "--engine", "--voice", "--text", "--file", "--out", "--format",
			"--pace", "--instruction", "--language")
	}
	positional, err := result.parseFlags(args, allowed)
	if err != nil {
		return options{}, err
	}
	if err := result.validate(positional); err != nil {
		return options{}, err
	}
	return result, nil
}

// parseFlags отделяет значения, позиционные слова и JSON-режим.
// Неизвестный аргумент не отражается в диагностике, чтобы не вывести ключ.
func (result *options) parseFlags(args, allowed []string) ([]string, error) {
	var positional []string
	seen := make(map[string]bool)
	for index := 0; index < len(args); index++ {
		flag := args[index]
		if !strings.HasPrefix(flag, "-") {
			positional = append(positional, flag)
			continue
		}
		if !slices.Contains(allowed, flag) {
			return nil, voicecore.Usage("неизвестный флаг для этой команды")
		}
		if seen[flag] {
			return nil, voicecore.Usage("повтор флага " + flag)
		}
		seen[flag] = true
		if flag == "--json" {
			result.json = true
			continue
		}
		index++
		if index == len(args) || strings.HasPrefix(args[index], "--") {
			return nil, voicecore.Usage("после " + flag + " нужно значение")
		}
		value := args[index]
		if localapi.TrimSpace(value) == "" && flag != "--text" && flag != "--instruction" {
			return nil, voicecore.Usage("значение " + flag + " не может быть пустым")
		}
		result.values[flag] = value
	}
	return positional, nil
}

// validate проверяет выбор движка и допустимость входов генерации до конфигурации.
// Явный текст, даже пустой, не заменяется содержимым одноимённого файла.
func (result *options) validate(positional []string) error {
	if result.name == "install" {
		if len(positional) != 1 || positional[0] != "piper" && positional[0] != "silero" {
			return voicecore.Usage("install требует ровно один движок: piper или silero")
		}
		result.engine = positional[0]
		return nil
	}
	if len(positional) != 0 {
		return voicecore.Usage("лишние позиционные аргументы")
	}
	result.engine = result.values["--engine"]
	if result.engine != "" && !slices.Contains(engines, result.engine) {
		return voicecore.Usage("неизвестный движок")
	}
	if result.name != "generate" {
		return nil
	}
	_, hasText := result.values["--text"]
	_, hasFile := result.values["--file"]
	if !hasText && !hasFile {
		return voicecore.Usage("generate требует --text или --file")
	}
	if hasText && hasFile {
		return voicecore.Usage("укажите либо --text, либо --file")
	}
	if pace := result.values["--pace"]; pace != "" && !slices.Contains(voicecore.Paces, pace) {
		return voicecore.Usage("неизвестный темп; допустимы slowest, slow, normal, fast, fastest")
	}
	if format := result.values["--format"]; format != "" && format != "wav" {
		return voicecore.Usage("неподдержанный формат; в v1 доступен только wav")
	}
	return nil
}
