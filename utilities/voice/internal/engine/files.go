package engine

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/voice/internal/local"
	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

type FileEngine struct {
	Pack local.Package
	Root string
	Run  local.Runner

	cached voicecore.Doctor
	since  time.Time
}

// Meta возвращает статические данные одной локальной модели.
// Имена и голоса по умолчанию совпадают с принятым каталогом CLI.
func (engine *FileEngine) Meta() voicecore.Metadata {
	name, defaultVoice := "Piper (локально)", engine.Pack.ID
	if engine.Pack.EngineID == "silero" {
		name, defaultVoice = "Silero (локально)", "xenia"
	}
	return voicecore.Metadata{
		ID:      engine.Pack.EngineID,
		Name:    name,
		Kind:    "local",
		Model:   engine.Pack.ID,
		Default: defaultVoice,
	}
}

// Capabilities объявляет русский WAV и темп для обоих локальных движков.
// Ударения в локальном режиме применяет Silero.
func (engine *FileEngine) Capabilities() voicecore.Capabilities {
	return voicecore.Capabilities{
		Languages: []string{"ru"},
		Pace:      true,
		Stress:    engine.Pack.EngineID == "silero",
		MaxChars:  2000,
		Formats:   []string{"wav"},
	}
}

type installed struct {
	model    string
	config   string
	speakers []local.Speaker
}

// manifest проверяет принятую модель и имена файлов относительно каталога пакета.
// Неизвестный или неполный снимок означает отсутствие рабочей модели.
func (engine *FileEngine) manifest() *installed {
	root := engine.Pack.ModelRoot(engine.Root)
	data, err := os.ReadFile(filepath.Join(root, "voice.json"))
	if err != nil {
		return nil
	}
	var value struct {
		ID         string          `json:"id"`
		Language   string          `json:"language"`
		SampleRate float64         `json:"sampleRate"`
		Name       *string         `json:"name"`
		Timbre     *string         `json:"timbre"`
		Model      string          `json:"model"`
		Config     string          `json:"config"`
		File       string          `json:"file"`
		Speakers   []local.Speaker `json:"speakers"`
	}
	if json.Unmarshal(data, &value) != nil || value.ID != engine.Pack.ID ||
		value.Language != "ru" || value.SampleRate <= 0 {
		return nil
	}
	if engine.Pack.EngineID == "piper" {
		return piperModel(root, value.ID, value.Model, value.Config, value.Name, value.Timbre)
	}
	model := acceptedFile(root, value.File)
	if model == "" || !engine.validSpeakers(value.Speakers) {
		return nil
	}
	return &installed{model: model, speakers: value.Speakers}
}

// validSpeakers проверяет принадлежность дикторов каталогу и отсутствие повторов.
// Их порядок сохраняется таким, каким его записал установщик.
func (engine *FileEngine) validSpeakers(speakers []local.Speaker) bool {
	seen := make(map[string]bool)
	for _, speaker := range speakers {
		if seen[speaker.ID] || !listed(engine.Pack.Speakers, speaker.ID) {
			return false
		}
		seen[speaker.ID] = true
	}
	return len(speakers) > 0
}

// acceptedFile допускает одно ненулевое имя в выбранном каталоге модели.
// Проверка сохраняет прежнее чтение принятого манифеста и файлов модели.
func acceptedFile(root, name string) string {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.Contains(name, "\\") {
		return ""
	}
	path := filepath.Join(root, name)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return ""
	}
	return path
}

func (engine *FileEngine) python() string {
	return filepath.Join(engine.Pack.EngineRoot(engine.Root), "venv", "bin", "python")
}

// Doctor проверяет реальный импорт в принятом окружении с коротким сроком.
// Кэш действует только в пределах текущего однократного процесса voice.
func (engine *FileEngine) Doctor(ctx context.Context) (voicecore.Doctor, error) {
	if ctx.Err() != nil {
		return voicecore.Doctor{}, voicecore.Failed("Операция отменена.")
	}
	if time.Since(engine.since) < 20*time.Second {
		return engine.cached, nil
	}
	state, err := engine.probe(ctx)
	if err == nil {
		engine.cached, engine.since = state, time.Now()
	}
	return state, err
}

// probe различает отсутствующую среду, повреждённую модель и отказ Python.
// При отмене диагностический статус не используется как fallback на другой движок.
func (engine *FileEngine) probe(ctx context.Context) (voicecore.Doctor, error) {
	label, module, model, duration := "Piper", "piper", "голос Piper не установлен или повреждён", 15*time.Second
	if engine.Pack.EngineID == "silero" {
		label, module, model, duration = "Silero", "torch", "модель Silero не установлена или повреждена", 90*time.Second
	}
	blocked := voicecore.Doctor{Status: "blocked", Install: "выполните: voice install " + engine.Pack.EngineID}
	info, err := os.Stat(engine.python())
	switch {
	case err != nil:
		blocked.Reason = "локальный " + label + " не установлен"
	case !info.Mode().IsRegular() || info.Mode()&0o111 == 0:
		blocked.Reason = "Python " + label + " не найден или не исполняемый"
	case engine.manifest() == nil:
		blocked.Reason = model
	default:
		run := engine.Run
		if run == nil {
			run = local.Run
		}
		if _, err := run(ctx, engine.python(), []string{"-c", "import " + module}, "", duration); err == nil {
			return voicecore.Doctor{Status: "ready", Reason: "готов без сети и ключей"}, nil
		}
		if ctx.Err() != nil {
			return voicecore.Doctor{}, voicecore.Failed("Операция отменена.")
		}
		blocked.Reason = "в окружении нет рабочего модуля " + module
	}
	return blocked, nil
}

// Voices показывает только реально установленные принятые голоса.
// Недоступный Python помечает их причиной doctor и не запускает синтез.
func (engine *FileEngine) Voices(ctx context.Context) ([]voicecore.Voice, error) {
	model := engine.manifest()
	if model == nil {
		return nil, nil
	}
	state, err := engine.Doctor(ctx)
	if err != nil {
		return nil, err
	}
	ready, reason := state.Status == "ready", state.Reason
	if ready {
		reason = ""
	}
	rows := make([]voicecore.Voice, 0, len(model.speakers))
	for _, speaker := range model.speakers {
		rows = append(rows, voicecore.Voice{
			ID:        speaker.ID,
			Name:      speaker.Name + " (" + speaker.Timbre + ")",
			Languages: []string{"ru"},
			Available: ready,
			Reason:    reason,
		})
	}
	return rows, nil
}

// Synthesize проверяет текст и диктора раньше импорта, затем использует принятую модель.
// Побочный эффект ровно один и остаётся у выбранного локального движка.
func (engine *FileEngine) Synthesize(ctx context.Context, input voicecore.Input) (voicecore.Result, error) {
	caps := engine.Capabilities()
	parsed, err := voicecore.Prepare(ctx, input, caps)
	if err != nil {
		return voicecore.Result{}, err
	}
	text := string(parsed.Text)
	label := "Piper"
	if engine.Pack.EngineID == "piper" {
		if input.Voice != engine.Pack.ID {
			return voicecore.Result{}, voicecore.Usage("Неизвестный голос Piper.")
		}
	} else {
		label = "Silero"
		if !listed(engine.Pack.Speakers, input.Voice) {
			return voicecore.Result{}, voicecore.Usage("Неизвестный голос Silero.")
		}
		if bad := unique(unreadable.FindAllString(text, -1)); len(bad) > 0 {
			return voicecore.Result{}, voicecore.Usage("Silero не читает: " + strings.Join(bad, ", ") + ".")
		}
		text = sileroText(parsed)
	}
	state, err := engine.Doctor(ctx)
	if err != nil {
		return voicecore.Result{}, err
	}
	if state.Status != "ready" {
		return voicecore.Result{}, voicecore.Failed(state.Reason)
	}
	model := engine.manifest()
	if model == nil || !listed(model.speakers, input.Voice) {
		return voicecore.Result{}, voicecore.Failed("Голос " + label + " не установлен или повреждён.")
	}
	result, err := local.Synthesize(ctx, local.Synthesis{
		Engine:  engine.Pack.EngineID,
		Python:  engine.python(),
		Model:   model.model,
		Config:  model.config,
		Speaker: input.Voice,
		Text:    text,
		Pace:    input.Pace,
		Output:  input.File,
	}, engine.Run)
	result.Ignored = voicecore.Ignored(input, parsed, caps)
	return result, err
}

func listed(speakers []local.Speaker, voice string) bool {
	return slices.ContainsFunc(speakers, func(speaker local.Speaker) bool { return speaker.ID == voice })
}

// unique сохраняет порядок и регистр первого появления фрагмента.
// Каждое повторное вхождение этой же строки не добавляет новую причину.
func unique(values []string) []string {
	seen := make(map[string]bool)
	out := make([]string, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}
