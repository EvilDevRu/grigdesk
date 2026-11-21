package local

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/voice/internal/voicecore"
	"grigdesk.local/tools/utilities/voice/internal/wav"
)

//go:embed python/piperSynth.py python/sileroSynth.py
var scripts embed.FS

type Runner func(context.Context, string, []string, string, time.Duration) ([]byte, error)

// Run запускает один процесс с отдельной группой и доставляет EOF после текста.
// При отмене завершает свою группу и ждёт закрытия ресурсов дочерней команды.
func Run(
	ctx context.Context, program string, args []string, input string, duration time.Duration,
) ([]byte, error) {
	bounded, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	if bounded.Err() != nil {
		return nil, voicecore.Failed("Операция отменена.")
	}
	command := exec.Command(program, args...)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Stdin = strings.NewReader(input)
	var stdout boundedOutput
	command.Stdout = &stdout
	if err := command.Start(); err != nil {
		return nil, voicecore.Failed("Не удалось запустить процесс движка.")
	}
	closed := make(chan error, 1)
	go func() { closed <- command.Wait() }()
	select {
	case err := <-closed:
		if err != nil {
			return nil, voicecore.Failed("Процесс движка завершился с ошибкой.")
		}
		return stdout.Bytes(), nil
	case <-bounded.Done():
		stopGroup(command.Process.Pid, closed)
		if ctx.Err() != nil {
			return nil, voicecore.Failed("Операция отменена.")
		}
		return nil, voicecore.Failed("Истёк срок дочернего процесса.")
	}
}

type boundedOutput struct{ bytes.Buffer }

// Write оставляет в памяти ограниченный stdout диагностической команды.
// Лишние байты потребляются, чтобы они не блокировали pipe дочернего процесса.
func (output *boundedOutput) Write(data []byte) (int, error) {
	const limit = 512 * 1024
	remain := limit - output.Len()
	if remain > 0 {
		_, _ = output.Buffer.Write(data[:min(len(data), remain)])
	}
	return len(data), nil
}

// stopGroup завершает группу только что запущенного дочернего процесса.
// Если TERM не освободил ресурсы, KILL ограничивает время очистки.
func stopGroup(pid int, closed <-chan error) {
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	timer := time.NewTimer(400 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-closed:
	case <-timer.C:
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		<-closed
	}
}

type Synthesis struct {
	Engine  string
	Python  string
	Model   string
	Config  string
	Speaker string
	Text    string
	Pace    string
	Output  string
	Timeout time.Duration
}

var lengthScale = map[string]string{
	"slowest": "1.35", "slow": "1.15", "normal": "1", "fast": "0.9", "fastest": "0.8",
}

// Synthesize запускает встроенный Python для явно выбранной модели и файлов.
// Сценарий установки и рабочий синтез используют одинаковые проверки peak и WAV.
func Synthesize(ctx context.Context, request Synthesis, run Runner) (voicecore.Result, error) {
	if run == nil {
		run = Run
	}
	if request.Timeout == 0 {
		request.Timeout = 300 * time.Second
	}
	if request.Pace == "" {
		request.Pace = "normal"
	}
	return wav.Publish(ctx, request.Output, func(file string) error {
		program := "piperSynth.py"
		args := []string{"--model", request.Model, "--out", file}
		if request.Engine == "piper" {
			args = append(args, "--config", request.Config, "--length-scale", lengthScale[request.Pace])
		} else {
			program = "sileroSynth.py"
			args = append(args, "--speaker", request.Speaker, "--rate", request.Pace)
		}
		path, cleanup, err := materialize(filepath.Dir(file), program)
		if err != nil {
			return err
		}
		defer cleanup()
		reply, err := run(ctx, request.Python, append([]string{path}, args...), request.Text, request.Timeout)
		if err != nil {
			return err
		}
		return checkSpeech(reply)
	})
}

// materialize кладёт проверенный источник в принадлежащий вызову закрытый каталог.
// Извлечение происходит после валидации и не разделяет файл между процессами voice.
func materialize(parent, name string) (string, func(), error) {
	data, err := scripts.ReadFile("python/" + name)
	if err != nil {
		return "", nil, fmt.Errorf("Не удалось прочитать ресурс движка: %w", err)
	}
	directory, err := os.MkdirTemp(parent, ".voice-python-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(directory) }
	file := filepath.Join(directory, name)
	if err := os.WriteFile(file, data, 0o600); err != nil {
		cleanup()
		return "", nil, err
	}
	return file, cleanup, nil
}

func lastLine(output []byte) []byte {
	output = bytes.TrimSpace(output)
	return output[bytes.LastIndexByte(output, '\n')+1:]
}

// checkSpeech подтверждает конечную амплитуду из последней JSON-строки Python.
// Неполная диагностика и тишина не допускают публикацию файла.
func checkSpeech(reply []byte) error {
	var facts struct {
		Peak *float64 `json:"peak"`
	}
	if err := json.Unmarshal(lastLine(reply), &facts); err != nil {
		return voicecore.Failed("Движок не вернул корректные факты о речи.")
	}
	if facts.Peak == nil || math.IsNaN(*facts.Peak) || math.IsInf(*facts.Peak, 0) {
		return voicecore.Failed("Движок не вернул конечный пик речи.")
	}
	if *facts.Peak < 0.005 {
		return voicecore.Failed("Движок вернул тишину вместо речи.")
	}
	return nil
}
