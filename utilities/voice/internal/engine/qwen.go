package engine

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"

	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

//go:embed qwen-catalog.json
var qwenCatalog []byte

const tokenService = "qwencloud-token"

var languageNames = map[string]string{
	"zh": "Chinese", "en": "English", "fr": "French", "de": "German", "ru": "Russian",
	"it": "Italian", "es": "Spanish", "pt": "Portuguese", "ja": "Japanese", "ko": "Korean",
}

var tokenRates = map[string]float64{"slowest": 0.7, "slow": 0.85, "normal": 1, "fast": 1.15, "fastest": 1.3}
var stressedWords = regexp.MustCompile(`(?i)[а-яё]+\x{0301}[а-яё]*`)

type Qwen struct {
	Service string
	Key     string
	BaseURL string
}

// Meta определяет модель и голос из явно выбранного сервиса.
// Префикс ключа не меняет выбор профиля синтеза.
func (qwen Qwen) Meta() voicecore.Metadata {
	info := voicecore.Metadata{
		ID:      "qwen",
		Name:    "Qwen (облако)",
		Service: qwen.Service,
		Kind:    "cloud",
		Model:   "qwen3-tts-flash",
		Default: "Cherry",
	}
	if qwen.Service == tokenService {
		info.Name = "QwenCloud Token Plan (облако)"
		info.Model = "qwen-audio-3.0-tts-plus"
		info.Default = "longanhuan_v3.6"
	}
	return info
}

// Capabilities отражает различия лимитов, языка, темпа и разметки каждого API.
// Во всех случаях результирующий формат остаётся WAV.
func (qwen Qwen) Capabilities() voicecore.Capabilities {
	if qwen.Service == tokenService {
		return voicecore.Capabilities{
			Languages:   []string{"ru", "en", "zh"},
			Pace:        true,
			Stress:      true,
			StressMode:  "experimental",
			Instruction: true,
			MaxChars:    2000,
			Formats:     []string{"wav"},
		}
	}
	return voicecore.Capabilities{
		Languages: []string{"zh", "en", "fr", "de", "ru", "it", "es", "pt", "ja", "ko"},
		MaxChars:  600,
		Formats:   []string{"wav"},
	}
}

// Doctor проверяет происхождение ключа по правилам выбранного профиля.
// Фактическое разрешение синтеза подтверждается только вызовом generate.
func (qwen Qwen) Doctor(context.Context) (voicecore.Doctor, error) {
	subscribed := strings.HasPrefix(qwen.Key, "sk-sp-")
	state := voicecore.Doctor{Status: "blocked"}
	switch {
	case qwen.Service == tokenService && subscribed:
		state.Status, state.Reason = "ready", "подписочный ключ задан; доступ подтверждает живой запрос"
	case qwen.Service == tokenService:
		state.Reason = "нет ключа QwenCloud Token Plan формата sk-sp-…"
		state.Install = "задайте TOKEN_PLAN_API_KEY или GRIGDESK_VOICE_QWEN_API_KEY"
	case subscribed:
		state.Reason = "ключ подписки несовместим с model-studio"
		state.Install = "для QwenCloud Token Plan укажите --service qwencloud-token"
	case qwen.Key != "":
		state.Status, state.Reason = "ready", "ключ задан"
	default:
		state.Reason = "нет ключа"
		state.Install = "задайте GRIGDESK_VOICE_QWEN_API_KEY или DASHSCOPE_API_KEY"
	}
	return state, nil
}

// Voices читает штатный каталог локально и добавляет текущую доступность.
// Просмотр списка голосов никогда не отправляет запрос облаку.
func (qwen Qwen) Voices(ctx context.Context) ([]voicecore.Voice, error) {
	var catalog struct {
		Studio []voicecore.Voice `json:"studio"`
		Token  []voicecore.Voice `json:"token"`
	}
	if err := json.Unmarshal(qwenCatalog, &catalog); err != nil {
		return nil, err
	}
	state, _ := qwen.Doctor(ctx)
	voices, reason := catalog.Studio, "нет ключа"
	if qwen.Service == tokenService {
		voices, reason = catalog.Token, "нет подписочного ключа"
	} else if strings.HasPrefix(qwen.Key, "sk-sp-") {
		reason = "нужен выбор подписочного сервиса"
	}
	for i := range voices {
		voices[i].Available = state.Status == "ready"
		if !voices[i].Available {
			voices[i].Reason = reason
		}
		if qwen.Service != tokenService {
			voices[i].Timbre, voices[i].Styles = "", nil
		}
	}
	return voices, nil
}

// Synthesize проверяет выбранные язык, голос и предел текста до сетевой передачи.
// После отказа ни сервис, ни облачный ключ не заменяются другими.
func (qwen Qwen) Synthesize(ctx context.Context, input voicecore.Input) (voicecore.Result, error) {
	caps := qwen.Capabilities()
	prepared, err := voicecore.Prepare(ctx, input, caps)
	if err != nil {
		return voicecore.Result{}, err
	}
	voices, err := qwen.Voices(ctx)
	if err != nil {
		return voicecore.Result{}, err
	}
	index := slices.IndexFunc(voices, func(row voicecore.Voice) bool { return row.ID == input.Voice })
	if qwen.Service == tokenService {
		if index < 0 {
			const message = "Неизвестный голос Qwen Token Plan. Посмотрите список командой voice voices."
			return voicecore.Result{}, voicecore.Usage(message)
		}
		return qwen.token(ctx, input, prepared, voices[index])
	}
	if index < 0 {
		return voicecore.Result{}, voicecore.Usage("Неизвестный голос Qwen.")
	}
	if qwen.Key == "" {
		return voicecore.Result{}, voicecore.Failed("Нет ключа Qwen.")
	}
	if strings.HasPrefix(qwen.Key, "sk-sp-") {
		return voicecore.Result{}, voicecore.Failed(
			"Ключ подписки не подходит model-studio; для Token Plan укажите --service qwencloud-token.")
	}
	language := "Auto"
	if input.Language != "" {
		language = languageNames[input.Language]
	}
	payload := struct {
		Text     string `json:"text"`
		Voice    string `json:"voice"`
		Language string `json:"language_type"`
	}{Text: string(prepared.Text), Voice: input.Voice, Language: language}
	const endpoint = "/api/v1/services/aigc/multimodal-generation/generation"
	result, err := qwen.audio(ctx, endpoint, input.File, payload, false)
	result.Ignored = voicecore.Ignored(input, prepared, caps)
	return result, err
}

// token строит запрос подписки с языковым указанием и экспериментальными ударениями.
// Подсказка объединяется с инструкцией пользователя под общим пределом 1600 символов.
func (qwen Qwen) token(
	ctx context.Context, input voicecore.Input, text voicecore.Prepared, voice voicecore.Voice,
) (voicecore.Result, error) {
	language := input.Language
	if language == "" {
		language = voicecore.Language(text.Text)
		if !slices.Contains(voice.Languages, language) {
			language = voice.Languages[0]
		}
	}
	if !slices.Contains(voice.Languages, language) {
		languages := strings.Join(voice.Languages, ", ")
		message := fmt.Sprintf("Голос «%s» поддерживает языки: %s.", voice.Name, languages)
		return voicecore.Result{}, voicecore.Usage(message)
	}
	marked := tokenText(text)
	instruction, err := tokenInstruction(marked, language, input.Instruction)
	if err != nil {
		return voicecore.Result{}, err
	}
	if !strings.HasPrefix(qwen.Key, "sk-sp-") {
		return voicecore.Result{}, voicecore.Failed("Для qwencloud-token нужен подписочный ключ sk-sp-….")
	}
	payload := struct {
		Text        string   `json:"text"`
		Voice       string   `json:"voice"`
		Format      string   `json:"format"`
		SampleRate  int      `json:"sample_rate"`
		Languages   []string `json:"language_hints"`
		Rate        float64  `json:"rate"`
		Instruction string   `json:"instruction"`
	}{
		Text: marked, Voice: voice.ID, Format: "wav", SampleRate: 24000,
		Languages: []string{language}, Rate: tokenRates[input.Pace], Instruction: instruction,
	}
	const endpoint = "/api/v1/services/audio/tts/SpeechSynthesizer"
	result, err := qwen.audio(ctx, endpoint, input.File, payload, true)
	if strings.ContainsRune(marked, '\u0301') {
		result.Warnings = []string{"Ударения Qwen экспериментальны: проверьте произношение по аудио."}
	}
	return result, err
}

// tokenText переводит позиции ударения в Unicode-метки после гласной.
// Уже введённые комбинирующие метки остаются единственными.
func tokenText(text voicecore.Prepared) string {
	var result strings.Builder
	for i, r := range text.Text {
		result.WriteRune(r)
		if slices.Contains(text.Stress, i) && (i+1 == len(text.Text) || text.Text[i+1] != '\u0301') {
			result.WriteRune('\u0301')
		}
	}
	return result.String()
}

// tokenInstruction выдаёт общую подсказку и первые 12 разных размеченных слов.
// Проверка общей длины выполняется перед любым сетевым эффектом.
func tokenInstruction(text, language, instruction string) (string, error) {
	parts := []string{"Speak " + languageNames[language] + " naturally. Read only the provided text."}
	if strings.ContainsRune(text, '\u0301') {
		parts = append(parts, "Follow the acute accent marks: stress the marked vowel. Do not read explanations.")
		words := unique(stressedWords.FindAllString(text, -1))
		if len(words) > 0 {
			parts = append(parts, "Intended pronunciations: "+strings.Join(words[:min(12, len(words))], ", ")+".")
		}
	}
	if extra := strings.TrimSpace(instruction); extra != "" {
		parts = append(parts, extra)
	}
	combined := strings.Join(parts, " ")
	if len(utf16.Encode([]rune(combined))) > 1600 {
		return "", voicecore.Usage("Инструкция вместе с подсказкой ударений длиннее 1600 символов.")
	}
	return combined, nil
}
