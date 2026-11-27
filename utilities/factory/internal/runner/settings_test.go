package runner

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

// writeFeatureCLI пишет подмену Codex для проверки metadata.
// На features list выполняется переданное тело сценария.
func writeFeatureCLI(t *testing.T, script string) (binary, pidFile string) {
	t.Helper()
	dir := t.TempDir()
	pidFile = filepath.Join(dir, "pid")
	binary = filepath.Join(dir, "codex")
	body := "#!/bin/sh\ncase \"$1:$2\" in --version:*) echo codex-cli 0.172.0; exit 0;; esac\n" +
		"case \"$1:$2\" in features:list) " + strings.ReplaceAll(script, "{pid}", pidFile) +
		"; exit 0;; esac\nexit 4\n"
	if err := os.WriteFile(binary, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	return binary, pidFile
}

// probeRequest готовит запрос с валидной записью scope: cwd — временный checkout,
// окружение — только PATH и HOME, как их отдаёт Store.ReadStageMetadataScope.
func probeRequest(dir string) DispatchRequest {
	return DispatchRequest{
		Filesystem: "workspace-write", Worktree: dir,
		MetadataScope: &state.StageMetadataScope{MetadataEnvironment: map[string]string{
			"PATH": os.Getenv("PATH"), "HOME": dir,
		}},
	}
}

// TestCodexFeaturesProbeCutsSpeedOnTimeout доказывает, что дедлайн прерывает пробу.
// Зависший CLI не переживает дедлайн, оба флага остаются выключенными.
func TestCodexFeaturesProbeCutsSpeedOnTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("фикстура проверяет завершение Unix-сессии")
	}
	binary, pidFile := writeFeatureCLI(t, `printf '%s' "$$" >"{pid}"; exec sleep 120`)
	candidate := Candidate{Provider: "codex", Binary: binary}
	req := probeRequest(t.TempDir())
	start := time.Now()
	flags, err := probeCodexFeatures(t.Context(), req, candidate)
	if err == nil || flags.FastMode || flags.UltrafastMode {
		t.Fatalf("зависшая проба подтвердила ускорение: %+v %v", flags, err)
	}
	if elapsed := time.Since(start); elapsed > 15*time.Second {
		t.Fatalf("проба завершилась поздно: %s", elapsed)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Release()
	for until := time.Now().Add(3 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		err := process.Signal(syscall.Signal(0))
		if errors.Is(err, os.ErrProcessDone) || errors.Is(err, syscall.ESRCH) {
			break
		}
		if time.Now().After(until) {
			t.Fatalf("CLI пережил дедлайн пробы: pid=%d", pid)
		}
	}
}

// TestCodexFeaturesProbeParsesExactLines проверяет строгий разбор: три поля,
// literal true, иначе флаг выключен; отказ CLI тоже не подтверждает ускорение.
func TestCodexFeaturesProbeParsesExactLines(t *testing.T) {
	for script, want := range map[string]codexFeatures{
		`printf 'fast_mode stable true\nultrafast_mode stable true\n'`:       {true, true},
		`printf 'ultrafast_mode stable true\nfast_mode stable true\n'`:       {true, true},
		`printf 'fast_mode stable false\nultrafast_mode stable true\n'`:      {false, true},
		`printf 'fast_mode stable true\n'`:                                   {true, false},
		`printf 'fast_mode stable true extra\nultrafast_mode stable true\n'`: {false, true},
		`printf 'fast_mode stable yes\n'`:                                    {false, false},
		`printf ''`:                                                          {false, false},
	} {
		binary, _ := writeFeatureCLI(t, script)
		flags, err := probeCodexFeatures(t.Context(), probeRequest(t.TempDir()),
			Candidate{Provider: "codex", Binary: binary})
		if err != nil || flags != (codexFeatures{want.FastMode, want.UltrafastMode}) {
			t.Fatalf("%q: %+v %v", script, flags, err)
		}
	}
	for _, script := range []string{`exit 7`, `printf 'fast_mode stable true\n'; exit 3`} {
		binary, _ := writeFeatureCLI(t, script)
		flags, err := probeCodexFeatures(t.Context(), probeRequest(t.TempDir()),
			Candidate{Provider: "codex", Binary: binary})
		if err == nil || flags != (codexFeatures{}) {
			t.Fatalf("%q: отказ CLI подтверждён как флаги: %+v %v", script, flags, err)
		}
	}
}

// TestApplyStageSpeedModes проверяет оба независимых источника допуска.
// При отсутствии записи каталог модели и обычный режим сохраняются.
func TestApplyStageSpeedModes(t *testing.T) {
	standard := []string{"standard"}
	fast := []string{"standard", "fast"}
	all := []string{"standard", "fast", "ultrafast"}
	for _, tc := range []struct {
		provider string
		scoped   bool
		flags    codexFeatures
		input    []string
		want     []string
	}{
		{"codex", false, codexFeatures{true, true}, all, standard},
		{"codex", true, codexFeatures{}, all, standard},
		{"codex", true, codexFeatures{true, false}, all, fast},
		{"codex", true, codexFeatures{true, true}, all, all},
		{"claude", false, codexFeatures{}, fast, standard},
		{"claude", true, codexFeatures{}, fast, fast},
		{"kimi", true, codexFeatures{}, fast, nil},
	} {
		model := StageModel{ID: "fixture", Efforts: []string{"high"}, SpeedModes: slices.Clone(tc.input)}
		got := applyStageSpeedModes(tc.provider, []StageModel{model}, tc.scoped, tc.flags)[0]
		if !slices.Equal(got.SpeedModes, tc.want) || got.ID != model.ID ||
			!slices.Equal(got.Efforts, model.Efforts) {
			t.Fatalf("%s scoped=%t flags=%+v: %+v, ожидаются режимы %v",
				tc.provider, tc.scoped, tc.flags, got, tc.want)
		}
	}
}
