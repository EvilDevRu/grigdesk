package cli

import (
	"context"
	"fmt"
	"strings"

	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

// engineList использует один результат doctor для человекочитаемого и машинного вывода.
// Облачный doctor проверяет ключ локально, а локальный подтверждает импорт.
func engineList(ctx context.Context, engines []voicecore.Engine, asJSON bool) (string, error) {
	type item struct {
		voicecore.Metadata
		voicecore.Doctor
	}
	rows := make([]item, 0, len(engines))
	var output strings.Builder
	for _, engine := range engines {
		state, err := engine.Doctor(ctx)
		if err != nil {
			return "", err
		}
		meta := engine.Meta()
		rows = append(rows, item{Metadata: meta, Doctor: state})
		if !asJSON {
			_, _ = fmt.Fprintf(&output, "%s — %s (%s) — %s — %s", meta.ID, meta.Name, meta.Model,
				state.Status, state.Reason)
			if state.Install != "" {
				output.WriteString("; " + state.Install)
			}
			output.WriteByte('\n')
		}
	}
	if asJSON {
		return jsonLine(rows)
	}
	return output.String(), nil
}

// modelList описывает возможности моделей без doctor, файлов или сети.
// Статические возможности не зависят от доступности установленного движка.
func modelList(engines []voicecore.Engine, asJSON bool) (string, error) {
	type item struct {
		ID      string                 `json:"id"`
		Model   string                 `json:"model"`
		Service string                 `json:"service,omitempty"`
		Caps    voicecore.Capabilities `json:"capabilities"`
	}
	rows := make([]item, 0, len(engines))
	var output strings.Builder
	for _, engine := range engines {
		meta, caps := engine.Meta(), engine.Capabilities()
		rows = append(rows, item{ID: meta.ID, Model: meta.Model, Service: meta.Service, Caps: caps})
		if !asJSON {
			stress := first(caps.StressMode, yesNo(caps.Stress))
			_, _ = fmt.Fprintf(&output, "%s — %s; языки: %s; темп: %s; ударения: %s; "+
				"инструкция: %s; лимит: %d; форматы: %s\n", meta.ID, meta.Model, strings.Join(caps.Languages, ", "),
				yesNo(caps.Pace), stress, yesNo(caps.Instruction), caps.MaxChars, strings.Join(caps.Formats, ", "))
		}
	}
	if asJSON {
		return jsonLine(rows)
	}
	return output.String(), nil
}

func yesNo(flag bool) string {
	if flag {
		return "да"
	}
	return "нет"
}

// voiceList читает голосовой каталог выбранных движков и подписывает источник каждого.
// Пустой результат сохраняет массив для машины и подсказку установки для человека.
func voiceList(ctx context.Context, engines []voicecore.Engine, id string, asJSON bool) (string, error) {
	type item struct {
		voicecore.Voice
		Engine string `json:"engine"`
	}
	rows := make([]item, 0)
	var output strings.Builder
	var found bool
	for _, engine := range engines {
		meta := engine.Meta()
		if id != "" && meta.ID != id {
			continue
		}
		found = true
		voices, err := engine.Voices(ctx)
		if err != nil {
			return "", err
		}
		for _, voice := range voices {
			rows = append(rows, item{Voice: voice, Engine: meta.ID})
			if !asJSON {
				state := "доступен"
				if !voice.Available {
					state = "недоступен: " + voice.Reason
				}
				_, _ = fmt.Fprintf(&output, "%s/%s — %s; языки: %s; %s\n", meta.ID, voice.ID,
					voice.Name, strings.Join(voice.Languages, ", "), state)
			}
		}
	}
	if !found {
		return "", voicecore.Usage("Неизвестный движок.")
	}
	if asJSON {
		return jsonLine(rows)
	}
	if len(rows) == 0 {
		return "Голоса не установлены. Выполните voice install piper или voice install silero.\n", nil
	}
	return output.String(), nil
}
