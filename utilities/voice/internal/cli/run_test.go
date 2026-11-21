package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"grigdesk.local/tools/utilities/voice/internal/local"
	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

type engineFixture struct {
	voicecore.Engine
	synth func(voicecore.Input) (voicecore.Result, error)
}

func (engine engineFixture) Meta() voicecore.Metadata {
	return voicecore.Metadata{ID: "piper", Model: "irina", Default: "irina", Kind: "local"}
}

func (engine engineFixture) Synthesize(_ context.Context, input voicecore.Input) (voicecore.Result, error) {
	return engine.synth(input)
}

// TestLocalVoiceCommand проверяет чтение UTF-8 и полную передачу параметров выбранной модели.
// Инъекция позволяет убедиться, что CLI не обращается к другому движку или doctor.
func TestLocalVoiceCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	count := 0
	fixture := engineFixture{synth: func(input voicecore.Input) (voicecore.Result, error) {
		count++
		if input.Text != "прив+ет мир" || input.Voice != "irina" || input.Format != "wav" || input.Pace != "normal" {
			t.Errorf("вход адаптера %+v", input)
		}
		return voicecore.Result{
			File:    input.File,
			Bytes:   52,
			Ignored: []string{"ударения"},
		}, nil
	}}
	read := func(path string) ([]byte, error) {
		if path != "/fixture/text.txt" {
			t.Errorf("неверное чтение %s", path)
		}
		return []byte("прив+ет мир"), nil
	}
	deps := Dependencies{
		Read:  read,
		Build: func(configuration, []local.Package) []voicecore.Engine { return []voicecore.Engine{fixture} },
	}
	args := []string{"generate", "--engine", "piper", "--file", "/fixture/text.txt", "--out", "/fixture/result.wav"}
	code := (Command{Version: "0.2.0"}).RunWithIO(t.Context(), args, &stdout, &stderr, deps)
	if code != 0 || count != 1 || stderr.Len() != 0 {
		t.Fatalf("rc %d, синтезов %d, stderr %q", code, count, stderr.String())
	}
	var report map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil || report["file"] != "/fixture/result.wav" ||
		report["engine"] != "piper" || report["service"] != nil {
		t.Fatalf("неверный отчёт %q, %v", stdout.String(), err)
	}
}

// TestVoiceOptions и TestVoiceConfig проверяют ранние ошибки, порядок выбора ключа и сервиса.
// Диагностика не содержит сырых значений секрета.
func TestVoiceOptions(t *testing.T) {
	for _, args := range [][]string{
		{"generate", "--text", "тест", "--engine", "unknown"},
		{"generate", "--text", "тест", "--format", "mp3"},
		{"generate", "--text", "тест", "--file", "/fixture"},
		{"install", "unknown"},
	} {
		var stdout, stderr bytes.Buffer
		code := (Command{Version: "0.2.0"}).RunWithIO(t.Context(), args, &stdout, &stderr, Dependencies{})
		if code != 2 || stdout.Len() != 0 || stderr.Len() == 0 {
			t.Errorf("аргументы %v, rc %d, stderr %q", args, code, stderr.String())
		}
	}
}

// TestVoiceConfig проверяет приоритет аргументов, явного сервиса и файлового корня.
// Префикс токена не выбирает адрес сервиса автоматически.
func TestVoiceConfig(t *testing.T) {
	env := map[string]string{
		"GRIGDESK_VOICE_QWEN_API_KEY": "fixture-env",
		"DASHSCOPE_API_KEY":           "fixture-dashscope",
		"TOKEN_PLAN_API_KEY":          "sk-sp-fixture",
		"GRIGDESK_VOICE_QWEN_SERVICE": "qwencloud-token",
	}
	config, err := voiceConfig(map[string]string{"--api-key": " fixture-arg ", "--dir": "/fixture"}, env)
	if err != nil || config.Key != "fixture-arg" || config.Service != "qwencloud-token" || config.Dir != "/fixture" {
		t.Fatalf("неверный выбор конфигурации: %+v %v", config, err)
	}
	delete(env, "GRIGDESK_VOICE_QWEN_API_KEY")
	config, err = voiceConfig(map[string]string{"--service": "model-studio"}, env)
	if err != nil || config.Key != "fixture-dashscope" || !strings.Contains(config.Base, "dashscope-intl") {
		t.Fatalf("неверный выбор профиля: %+v %v", config, err)
	}
}
