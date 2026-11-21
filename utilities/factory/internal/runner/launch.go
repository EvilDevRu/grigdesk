package runner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

type routePolicy struct {
	filesystem, sandbox string
	addDirs             []string
	browser, shared     bool
}

type usage struct {
	InputTokens, OutputTokens, CachedInputTokens, CacheWriteInputTokens int64
	Fanout                                                              int
}

type Outcome struct {
	Classification, LimitUntil string
	RC                         int
	Usage                      usage
	Terminal                   state.RunSnapshot
}

type AdapterError struct {
	Code    int
	Marker  string
	Detail  string
	Restart *state.StageRunnerRestart
}

func (e *AdapterError) Error() string {
	return strings.TrimSpace(fmt.Sprintf("runner rc=%d %s %s", e.Code, e.Marker, e.Detail))
}

type Run struct {
	Store                                             state.Store
	Identity                                          state.RunIdentity
	Node                                              string
	Dir, Worktree, Factory, FactoryHome               string
	Model, Effort, Version, ExpectedVersion           string
	Wrapper, RuntimeHome, Binary                      string
	ExpectedIdentity, RuntimeIdentity, CacheDirectory string
	Environment                                       []string
	External                                          *externalCLI
	CodexShared                                       *CodexSharedAccess
	AgentControlDir                                   string
	ReadAgentRules                                    func(context.Context) ([]string, []string, error)
	Timeout                                           time.Duration
	Capability                                        string
	ConfirmRestart                                    func(state.RunIdentity) error
	RecordRestart                                     func(state.RunIdentity, state.StageRunnerRestart, bool) error
	context                                           context.Context
}

type invocation struct {
	path, cwd        string
	args             []string
	stdin            io.Reader
	env              []string
	deferred         bool
	wireHome         string
	configureBrowser func(context.Context, *host.ProcessLaunch, *browserScope) error
}

// invoke создаёт verified meta и направляет stderr CLI в run.Dir/stderr.log.
// Обе операции принадлежат хосту и предшествуют запуску внешней команды.
func (run Run) invoke(provider string, call invocation) (host.ProcessResult, *AdapterError) {
	if err := run.checkPhysical(call); err != nil {
		return host.ProcessResult{}, adapterError(4, err.Error())
	}
	call.path, call.args = run.External.command(call.path, call.args)
	logs, err := run.openLogs(provider)
	if err != nil {
		return host.ProcessResult{}, adapterError(78, err.Error())
	}
	defer logs.close()
	env, token, err := run.statusEnvironment(provider, call.deferred)
	if err != nil {
		return host.ProcessResult{}, adapterError(78, err.Error())
	}
	files := []*os.File(nil)
	if token != nil {
		defer token.Close()
		files = []*os.File{nil, nil, nil, nil, token}
	}
	env = append(run.External.withEnvironment(env), call.env...)
	ctx := run.context
	if ctx == nil {
		ctx = context.Background()
	}
	browser, err := run.prepareBrowser(provider, call.deferred)
	if err != nil {
		return host.ProcessResult{}, adapterError(79, err.Error())
	}
	processCtx, finishWatch := run.watchRestart(ctx)
	defer finishWatch()
	var unregister func() error
	var browserErr, ownerErr error
	var beforePermit func(*host.ProcessLaunch) error
	confirmRestart := func() error {
		if run.ConfirmRestart != nil {
			ownerErr = run.ConfirmRestart(run.Identity)
		}
		return ownerErr
	}
	stdin := call.stdin
	var promptWriter *os.File
	if browser != nil && provider == "codex" {
		reader, writer, err := os.Pipe()
		if err != nil {
			browser.close()
			return host.ProcessResult{}, adapterError(79, err.Error())
		}
		defer reader.Close()
		defer writer.Close()
		stdin, promptWriter = reader, writer
	}
	if browser != nil {
		defer browser.close()
		beforePermit = func(launch *host.ProcessLaunch) error {
			browser.applyPermit(launch)
			if browser.mode == "grigdesk" && call.configureBrowser != nil {
				browserErr = call.configureBrowser(processCtx, launch, browser)
				if browserErr != nil {
					return browserErr
				}
			}
			if err := confirmRestart(); err != nil {
				return err
			}
			if promptWriter != nil {
				go browser.writePrompt(promptWriter, call.stdin)
			}
			return nil
		}
	}
	recordOwner := func(owner host.TreeOwner) error {
		if run.Node != "" {
			unregister, ownerErr = run.Store.PublishStageRunnerProcess(
				run.Identity, run.Node, provider, run.Model, run.Effort, owner.Leader,
			)
			if ownerErr != nil {
				return ownerErr
			}
		}
		if browser != nil {
			browserErr = browser.start(processCtx, owner)
			return browserErr
		}
		return confirmRestart()
	}
	defer func() {
		if unregister != nil {
			_ = unregister()
		}
	}()
	var destination io.Writer = logs.events
	var wire *kimiWire
	if call.wireHome != "" {
		wire = startKimiWire(destination, call.wireHome)
		destination = wire
	}
	result := host.RunProcess(processCtx, host.Process{
		Path: call.path, Args: call.args, Dir: call.cwd, Env: env, Files: files,
		Stdin: stdin, StdoutSink: destination, StderrSink: logs.stderr,
		Timeout: run.Timeout, Limit: 128 * 1024, Owned: true, RecordOwner: recordOwner, BeforePermit: beforePermit,
	})
	if wire != nil {
		wire.close()
	}
	if ownerErr != nil {
		return result, adapterError(78, ownerErr.Error())
	}
	if browserErr != nil {
		return result, adapterError(79, browserErr.Error())
	}
	logs.finishDebug(run.debugResolution(), result.RC)
	if err := errors.Join(logs.events.Sync(), logs.stderr.Sync()); err != nil {
		return result, adapterError(74, "не удалось сохранить потоки запуска")
	}
	if result.OwnedTreeClosed {
		restart, err := run.Store.PendingStageRunnerRestart(run.Identity)
		if err != nil {
			return result, adapterError(78, err.Error())
		}
		if restart != nil {
			if ctx.Err() != nil {
				err := run.Store.AdvanceStageRunnerRestart(run.Identity, *restart, "failed", "Прогон остановлен.")
				if err != nil {
					return result, adapterError(78, err.Error())
				}
			} else {
				if err := run.recordRestart(*restart); err != nil {
					return result, adapterError(78, err.Error())
				}
				return result, &AdapterError{Code: 130, Detail: "запрошен перезапуск этапа", Restart: restart}
			}
		}
	}
	if call.deferred && result.RC == 0 {
		if rc, err := run.Store.ConsumeStatusRequests(run.Identity, run.Capability); err != nil {
			return result, adapterError(rc, err.Error())
		}
	}
	return result, nil
}

func (run Run) checkPhysical(call invocation) error {
	if !run.Identity.Valid() || run.Capability == "" || !filepath.IsAbs(call.path) ||
		!filepath.IsAbs(run.Dir) || filepath.Clean(run.Dir) != run.Dir || !filepath.IsAbs(call.cwd) {
		return fmt.Errorf("нужны физические пути и exact capability запуска")
	}
	for _, path := range []string{run.Dir, call.cwd, call.path} {
		physical, err := filepath.EvalSymlinks(path)
		if err != nil || path != physical {
			return fmt.Errorf("недопустимый путь запуска")
		}
	}
	return nil
}

type runtimeLogs struct {
	root           *os.Root
	events, stderr *os.File
	trace          *os.File
	debug          state.DebugResolution
}

func (run Run) openLogs(provider string) (*runtimeLogs, error) {
	if !knownProvider(provider) {
		return nil, fmt.Errorf("провайдер отсутствует в реестре")
	}
	root, err := os.OpenRoot(run.Dir)
	if err != nil {
		return nil, err
	}
	logs := &runtimeLogs{root: root, debug: run.debugResolution()}
	durable := fmt.Appendf(nil, "SOURCE=runtime\nRUNNER=%s\nRUN_ID=%s\nEPOCH=%d\nDEBUG_LEVEL=%s\nDEBUG_SOURCE=%s\n",
		provider, run.Identity.ID, run.Identity.Epoch, logs.debug.Level, logs.debug.Source)
	file, err := root.OpenFile("meta.env", os.O_WRONLY|os.O_EXCL|os.O_CREATE|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		logs.close()
		return nil, err
	}
	_, writeErr := file.Write(durable)
	if err := errors.Join(writeErr, file.Sync(), file.Close()); err != nil {
		logs.close()
		return nil, err
	}
	flags := os.O_WRONLY | os.O_APPEND | os.O_EXCL | os.O_CREATE | syscall.O_NOFOLLOW
	logs.events, err = root.OpenFile("events.jsonl", flags, 0600)
	if err == nil {
		logs.stderr, err = root.OpenFile("stderr.log", flags, 0600)
	}
	if err != nil {
		logs.close()
		return nil, err
	}
	if logs.debug.Level != "off" {
		logs.openTrace()
		logs.traceEvent("debug_started", map[string]string{
			"level": logs.debug.Level, "source": logs.debug.Source, "partial": "0",
		})
	}
	return logs, nil
}

func (logs *runtimeLogs) close() {
	if logs.events != nil {
		logs.events.Close()
	}
	if logs.stderr != nil {
		logs.stderr.Close()
	}
	if logs.trace != nil {
		logs.trace.Close()
	}
	logs.root.Close()
}

// statusEnvironment передаёт scope выбранного запуска и закрывает административные переменные.
// Для deferred транспорт получает writable state, секрет остаётся у хоста.
func (run Run) statusEnvironment(provider string, deferred bool) ([]string, *os.File, error) {
	id := run.Identity
	env := providerEnvironment(provider, run.Environment)
	env = append(env,
		"FACTORY_RUN_TASK="+id.Task, "FACTORY_RUN_STAGE="+id.Stage,
		"FACTORY_RUN_ID="+id.ID, "FACTORY_RUN_ATTEMPT="+id.Attempt,
		"FACTORY_RUN_EPOCH="+strconv.FormatUint(id.Epoch, 10),
		"FACTORY_STATE="+run.Store.StateDir, "STATE_DIR="+run.Store.StateDir,
		"FACTORY_STATUS_ENGINE_PROTOCOL=go-v1", "FACTORY_STATUS_BIN="+run.Factory,
		"FACTORY_STATUS_ENGINE_HOME="+run.FactoryHome, "FACTORY_LOOP_ROLE="+id.LoopRole,
	)
	if deferred {
		dir := run.Store.StatusRequestDir(id)
		if err := os.Mkdir(dir, 0700); err != nil {
			return nil, nil, err
		}
		return append(env, "FACTORY_STATUS_MODE=request", "FACTORY_STATUS_REQUEST_DIR="+dir), nil, nil
	}
	token, err := capabilityFile(run.Store.ControlDir, run.Capability)
	if err != nil {
		return nil, nil, err
	}
	return append(env, "FACTORY_STATUS_FD=7", "FACTORY_CONTROL_ROOT="+run.Store.ControlDir), token, nil
}

func capabilityFile(control, secret string) (*os.File, error) {
	file, err := os.CreateTemp(control, ".status-capability-")
	if err != nil {
		return nil, err
	}
	path := file.Name()
	defer os.Remove(path)
	if _, err := file.WriteString(secret + "\n"); err != nil {
		file.Close()
		return nil, err
	}
	file.Close()
	return os.Open(path)
}

// providerEnvironment ограничивает inheritance конкретным провайдером.
// Назначения среды из descriptor добавляются отдельно после этого списка.
func providerEnvironment(provider string, env []string) []string {
	result := make([]string, 0, len(env))
	prefix := strings.ToUpper(provider) + "_"
	qwenKeys := ""
	if provider == "qwen" {
		qwenKeys = "," + environmentMap(env)["FACTORY_QWEN_CREDENTIAL_NAMES"] + ","
	}
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if key == "GRIGDESK_GLM_ROUTE_KEY" {
			continue
		}
		if systemRunnerEnv(key) || strings.HasPrefix(key, prefix) ||
			strings.HasPrefix(key, "GRIGDESK_"+prefix) ||
			(provider == "qwen" && (key == "DASHSCOPE_API_KEY" || strings.Contains(qwenKeys, ","+key+","))) ||
			(provider == "glm" && (key == "ZAI_API_KEY" || key == "ZAI_CODING_API_KEY")) ||
			(provider == "claude" && strings.HasPrefix(key, "ANTHROPIC_")) ||
			(provider == "codex" && strings.HasPrefix(key, "OPENAI_")) {
			result = append(result, entry)
		}
	}
	return result
}

func systemRunnerEnv(key string) bool {
	switch key {
	case "PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR", "FACTORY_HOME", "FACTORY_FORBID_LIVE",
		"XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "GRIGDESK_RUNTIME_ROOT",
		"FACTORY_DARWIN_PROCESS_HELPER", "FACTORY_DARWIN_PROCESS_HELPER_SHA256":
		return true
	default:
		return false
	}
}

func adapterError(code int, detail string) *AdapterError {
	return &AdapterError{Code: code, Detail: detail}
}

func (run Run) terminal(result host.ProcessResult, class string) (Outcome, *AdapterError) {
	outcome := Outcome{Classification: class, RC: result.RC}
	if result.RC != 0 {
		return outcome, adapterError(result.RC, "CLI вернул ошибку")
	}
	observed, rc, err := run.Store.ReadRun(run.Identity)
	if err != nil {
		return outcome, adapterError(rc, err.Error())
	}
	if observed.State != "committed" {
		outcome.Classification, outcome.RC = "no_result", 76
		return outcome, adapterError(76, "CLI вышел без stage-result")
	}
	outcome.Terminal = observed
	return outcome, nil
}

var providerIDs = []string{"claude", "codex", "deepseek", "glm", "kimi", "qwen"}

func knownProvider(name string) bool {
	for _, id := range providerIDs {
		if name == id {
			return true
		}
	}
	return false
}
