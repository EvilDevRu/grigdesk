package cli

import (
	"context"
	_ "embed"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"grigdesk.local/tools/utilities/internal/buildinfo"
	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/voice/internal/engine"
	"grigdesk.local/tools/utilities/voice/internal/local"
	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

//go:embed help.txt
var help string

const kind = "voice"

type Command struct {
	Version string
}

type Dependencies struct {
	Env   map[string]string
	Read  func(string) ([]byte, error)
	Build func(configuration, []local.Package) []voicecore.Engine
}

// Run связывает одноразовую команду с файлами и окружением процесса.
// Справка и метаданные выбираются без подключения к любому движку.
func (command Command) Run(
	ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer,
) int {
	return command.RunWithIO(ctx, args, stdout, stderr, Dependencies{
		Env:   localapi.ProcessEnv(),
		Read:  os.ReadFile,
		Build: buildEngines,
	})
}

// RunWithIO проверяет аргументы и возвращает один финальный ответ или безопасную причину.
// Тесты передают свои файлы и движки через тот же диспетчер, что и работающий CLI.
func (command Command) RunWithIO(
	ctx context.Context, args []string, stdout, stderr io.Writer, deps Dependencies,
) int {
	if code, done := buildinfo.Local(stdout, args, kind, command.Version, false); done {
		return code
	}
	opts, err := parse(args)
	if err != nil {
		return fail(stderr, err, nil)
	}
	if opts.name == "version" {
		code, _ := buildinfo.Local(stdout, []string{"--version"}, kind, command.Version, false)
		return code
	}
	if opts.name == "help" {
		return writeAnswer(stdout, stderr, help)
	}

	secrets := []string{opts.values["--api-key"], deps.Env["GRIGDESK_VOICE_QWEN_API_KEY"],
		deps.Env["TOKEN_PLAN_API_KEY"], deps.Env["DASHSCOPE_API_KEY"]}
	result, err := execute(ctx, opts, deps, stderr)
	if err != nil {
		return fail(stderr, err, secrets)
	}
	return writeAnswer(stdout, stderr, result)
}

// execute отделяет установку от чтения каталогов и генерации.
// Ровно одна выбранная операция получает конфигурацию voice.
func execute(ctx context.Context, opts options, deps Dependencies, stderr io.Writer) (string, error) {
	config, err := voiceConfig(opts.values, deps.Env)
	if err != nil {
		return "", err
	}
	packages, err := local.Packages()
	if err != nil {
		return "", err
	}
	if opts.name == "install" {
		return install(ctx, opts, config.Dir, packages, stderr)
	}
	engines := deps.Build(config, packages)
	switch opts.name {
	case "generate":
		return generate(ctx, opts, engines, deps.Read)
	case "engines":
		return engineList(ctx, engines, opts.json)
	case "models":
		return modelList(engines, opts.json)
	default:
		return voiceList(ctx, engines, opts.engine, opts.json)
	}
}

// buildEngines сохраняет порядок автовыбора и использует только каталог команды.
// Ключ не передаётся локальным Python-адаптерам как параметр синтеза.
func buildEngines(config configuration, packages []local.Package) []voicecore.Engine {
	engines := []voicecore.Engine{engine.Qwen{Service: config.Service, Key: config.Key, BaseURL: config.Base}}
	for _, pack := range packages {
		engines = append(engines, &engine.FileEngine{Pack: pack, Root: config.Dir})
	}
	return engines
}

// install находит закреплённый пакет и выводит только финальную принятую установку.
// Прогресс и ошибки идут отдельно от машины вывода JSON.
func install(
	ctx context.Context, opts options, root string, packages []local.Package, stderr io.Writer,
) (string, error) {
	for _, pack := range packages {
		if pack.EngineID != opts.engine {
			continue
		}
		result, err := local.Install(ctx, local.InstallSpec{
			Package:   pack,
			Directory: root,
			Log:       func(message string) { _, _ = fmt.Fprintln(stderr, message) },
		})
		if err != nil {
			return "", err
		}
		if opts.json {
			return jsonLine(result)
		}
		return fmt.Sprintf("Установлен %s: %s.\n", result.Engine, result.Package), nil
	}
	return "", voicecore.Usage("Установка доступна для piper или silero.")
}

// generate считывает один вход, выбирает движок один раз и ждёт принятого WAV.
// После отрицательного результата другой движок не получает исходные данные.
func generate(
	ctx context.Context, opts options, engines []voicecore.Engine, read func(string) ([]byte, error),
) (string, error) {
	text, err := generationText(opts, read)
	if err != nil {
		return "", err
	}
	selected, err := selectEngine(ctx, engines, opts.engine)
	if err != nil {
		return "", err
	}
	meta := selected.Meta()
	voice := first(opts.values["--voice"], meta.Default)
	target := opts.values["--out"]
	if target == "" {
		stamp := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		stamp = strings.NewReplacer(":", "-", ".", "-").Replace(stamp)
		target = "voice-" + stamp + "-" + voicecore.UUID() + ".wav"
	}
	result, err := selected.Synthesize(ctx, voicecore.Input{
		Text:        text,
		Voice:       voice,
		Language:    opts.values["--language"],
		File:        target,
		Format:      first(opts.values["--format"], "wav"),
		Pace:        first(opts.values["--pace"], "normal"),
		Instruction: opts.values["--instruction"],
	})
	if err != nil {
		return "", err
	}
	return generationReport(meta, voice, result)
}

// generationText читает явный файл в строгом UTF-8 или использует строковый аргумент.
// Пробельный текст завершается до probe и сети.
func generationText(opts options, read func(string) ([]byte, error)) (string, error) {
	text, exists := opts.values["--text"]
	if !exists {
		data, err := read(opts.values["--file"])
		if err != nil {
			return "", voicecore.Failed("Не удалось прочитать файл текста.")
		}
		if !utf8.Valid(data) {
			return "", voicecore.Usage("Файл текста должен содержать корректный UTF-8.")
		}
		text = string(data)
	}
	if localapi.TrimSpace(text) == "" {
		return "", voicecore.Usage("Пустой текст для синтеза.")
	}
	return text, nil
}

// selectEngine сначала выбирает явный движок либо первый доступный после doctor.
// Ошибка синтеза обрабатывается выше и не перезапускает выбор.
func selectEngine(
	ctx context.Context, engines []voicecore.Engine, requested string,
) (voicecore.Engine, error) {
	for _, engine := range engines {
		if requested != "" {
			if engine.Meta().ID == requested {
				return engine, nil
			}
			continue
		}
		doctor, err := engine.Doctor(ctx)
		if err != nil {
			return nil, err
		}
		if doctor.Status == "ready" {
			return engine, nil
		}
	}
	if requested != "" {
		return nil, voicecore.Usage("Неизвестный движок.")
	}
	return nil, voicecore.Failed("нет готового движка: задайте ключ Qwen (GRIGDESK_VOICE_QWEN_API_KEY) " +
		"или установите локальный (voice install piper)")
}

// generationReport фиксирует выбранный сервис и проверенные свойства файла.
// Локальная модель передаёт явный null в поле service, предупреждения остаются массивом.
func generationReport(meta voicecore.Metadata, voice string, result voicecore.Result) (string, error) {
	var service *string
	if meta.Service != "" {
		service = &meta.Service
	}
	return jsonLine(struct {
		Engine   string   `json:"engine"`
		Model    string   `json:"model"`
		Service  *string  `json:"service"`
		Voice    string   `json:"voice"`
		File     string   `json:"file"`
		Bytes    int64    `json:"bytes"`
		Format   string   `json:"format"`
		Ignored  []string `json:"ignoredDirections"`
		Warnings []string `json:"warnings"`
	}{
		Engine: meta.ID, Model: meta.Model, Service: service, Voice: voice, File: result.File,
		Bytes: result.Bytes, Format: "wav", Ignored: result.Ignored, Warnings: result.Warnings,
	})
}

func jsonLine(value any) (string, error) {
	encoded, err := jsonv2.Marshal(value)
	return string(encoded) + "\n", err
}

// writeAnswer выводит только полный отчёт команды.
// Закрытый pipe штатен, а другая ошибка вывода получает собственный код.
func writeAnswer(stdout, stderr io.Writer, result string) int {
	written, err := io.WriteString(stdout, result)
	if err == nil && written == len(result) || errors.Is(err, syscall.EPIPE) {
		return 0
	}
	return fail(stderr, voicecore.Failed("Не удалось записать ответ voice."), nil)
}

// fail печатает лишь ожидаемую, очищенную причину отказа.
// Внешний стек и исходное исключение остаются внутри CLI.
func fail(stderr io.Writer, err error, secrets []string) int {
	code, reason := 1, "Не удалось выполнить команду voice."
	var known *voicecore.Failure
	if errors.As(err, &known) {
		code, reason = known.Code, known.Text
	}
	_, _ = fmt.Fprintln(stderr, redact(reason, secrets...))
	return code
}
