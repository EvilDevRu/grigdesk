package hooks

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

type AgentControl struct {
	Directory string
	Codex     bool
	ReadDirs  []string
	WriteDirs []string
	input     *os.File
	result    <-chan host.ProcessResult
	cancel    context.CancelFunc
}

const agentControlTimeout = 30 * time.Second

type AgentRules struct {
	Allow, Deny []string
}

// ReadAgentRules принимает только строки правил доверенного профиля и exact run key.
// Общие правила и правила отдельного этапа остаются в исходном порядке.
func ReadAgentRules(ctx context.Context, invocation Invocation, stage string) (AgentRules, error) {
	var rules AgentRules
	if !commandRunKey.MatchString(stage) {
		return rules, fmt.Errorf("недопустимый run key правил агента")
	}
	result := runBridge(ctx, invocation, "agent-rules", stage)
	if err := hookFailure("правила агента профиля", result); err != nil {
		return rules, err
	}
	if result.OutputOverflow {
		return rules, fmt.Errorf("правила агента превысили 64 KiB")
	}
	for _, row := range strings.Split(strings.TrimSuffix(string(result.Stdout), "\n"), "\n") {
		if row == "" {
			continue
		}
		kind, rule, ok := strings.Cut(row, "\t")
		if !ok || !commandText(rule, 2048) {
			return AgentRules{}, fmt.Errorf("повреждена строка правила агента")
		}
		switch kind {
		case "allow":
			rules.Allow = append(rules.Allow, rule)
		case "deny":
			rules.Deny = append(rules.Deny, rule)
		default:
			return AgentRules{}, fmt.Errorf("неизвестный вид правила агента")
		}
	}
	return rules, nil
}

// OpenAgentControl удерживает один профильный shell на весь визит узла.
// Потеря родительского pipe сообщает shell об остановке независимо от провайдера.
func OpenAgentControl(ctx context.Context, invocation Invocation, task, stage string) (*AgentControl, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !commandTask.MatchString(task) || !commandRunKey.MatchString(stage) {
		return nil, fmt.Errorf("недопустимый task/run key профильного канала")
	}
	command, err := bridgeProcess(invocation, "agent-control", task, stage)
	if err != nil {
		return nil, err
	}
	input, finish, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	reader, writer := io.Pipe()
	ready := make(chan string, 1)
	go func() {
		defer reader.Close()
		line, err := bufio.NewReaderSize(reader, 8192).ReadSlice('\n')
		if err == nil {
			ready <- string(line)
		}
		close(ready)
		_, _ = io.Copy(io.Discard, reader)
	}()
	processContext, cancel := context.WithCancel(context.WithoutCancel(ctx))
	result := make(chan host.ProcessResult, 1)
	command.Stdin, command.StdoutSink, command.Timeout = input, writer, 0
	go func() {
		defer input.Close()
		defer writer.Close()
		result <- host.RunProcess(processContext, command)
	}()
	control := &AgentControl{input: finish, result: result, cancel: cancel}
	return control.awaitReady(ctx, ready)
}

// awaitReady отменяет вход в этап при повреждённом или просроченном ответе.
// Если start успел создать канал, shell получает явный код для stop.
func (control *AgentControl) awaitReady(ctx context.Context, ready <-chan string) (*AgentControl, error) {
	var err error
	rc := 78
	select {
	case line := <-ready:
		if line == "absent\n" {
			return nil, control.Close(0)
		}
		if control.parseReady(line) {
			return control, nil
		}
		err = fmt.Errorf("профиль не открыл приватный канал этапа")
	case <-ctx.Done():
		rc, err = 130, ctx.Err()
	case <-time.After(agentControlTimeout):
		err = fmt.Errorf("истекло время открытия профильного канала")
	}
	if cleanup := control.Close(rc); cleanup != nil {
		return nil, fmt.Errorf("%v: %w", err, cleanup)
	}
	return nil, err
}

// parseReady принимает только каталог и необязательный набор корней профиля Codex.
// Строки путей используют прежний формат профильных переменных.
func (control *AgentControl) parseReady(line string) bool {
	wire, found := strings.CutPrefix(strings.TrimSuffix(line, "\n"), "ready\t")
	fields := strings.Split(wire, "\t")
	if !found || !isAgentControlDirectory(fields[0]) {
		return false
	}
	control.Directory = fields[0]
	if len(fields) == 1 {
		return true
	}
	if len(fields) != 4 || fields[1] != "codex" {
		return false
	}
	control.Codex = true
	control.ReadDirs = strings.Fields(fields[2])
	control.WriteDirs = strings.Fields(fields[3])
	return true
}

// Close запрашивает профильное закрытие и ждёт завершения его дерева.
// Вызывается один раз владельцем визита после окончания работы провайдера.
func (control *AgentControl) Close(rc int) error {
	defer control.cancel()
	_, _ = io.WriteString(control.input, strconv.Itoa(rc)+"\n")
	_ = control.input.Close()
	select {
	case result := <-control.result:
		return hookFailure("профильный канал этапа", result)
	case <-time.After(agentControlTimeout):
		control.cancel()
		result := <-control.result
		if err := hookFailure("закрытие профильного канала", result); err != nil {
			return err
		}
		return fmt.Errorf("истекло время закрытия профильного канала")
	}
}

// isAgentControlDirectory проверяет отдельный локальный каталог брокера.
// Лексические совпадения и каталоги через symlink не являются допуском.
func isAgentControlDirectory(path string) bool {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return false
	}
	physical, err := filepath.EvalSymlinks(path)
	if err != nil || physical != path {
		return false
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid())
}
