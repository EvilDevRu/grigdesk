package runner

import (
	"encoding/json"
	"os"
	"strconv"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

// debugResolution перечитывает только уровни диагностики точной попытки.
// Ошибка чтения не меняет допуск, статус или исход запуска.
func (run Run) debugResolution() state.DebugResolution {
	attempt, setting, err := run.Store.ReadTaskDebug(run.Identity.Task)
	if err != nil || attempt.ID != run.Identity.Attempt {
		return state.DebugResolution{Level: "off", Source: "invalid_task"}
	}
	config := state.DebugConfigRoot(environmentMap(run.Environment))
	return state.ResolveDebug(config, attempt.Profile, setting, time.Now().Unix())
}

func (logs *runtimeLogs) openTrace() {
	flags := os.O_WRONLY | os.O_CREATE | os.O_EXCL | syscall.O_NOFOLLOW
	logs.trace, _ = logs.root.OpenFile("debug.trace.jsonl", flags, 0600)
}

// finishDebug фиксирует уровень на границе возвращения хоста и код процесса.
// Диагностическая запись ограничена типизированными полями хоста.
func (logs *runtimeLogs) finishDebug(current state.DebugResolution, code int) {
	if current.Level == "off" {
		if logs.debug.Level != "off" {
			logs.traceEvent("debug_disabled", map[string]string{"source": current.Source})
		}
		return
	}
	switch {
	case logs.debug.Level == "off":
		logs.openTrace()
		logs.traceEvent("debug_enabled", map[string]string{
			"level": current.Level, "source": current.Source, "partial": "1",
		})
	case logs.debug.Level != current.Level:
		logs.traceEvent("debug_level_changed", map[string]string{
			"level": current.Level, "source": current.Source,
		})
	}
	if code != 0 || current.Level == "decisions" || current.Level == "verbose" {
		logs.traceEvent("runner_exit", map[string]string{"rc": strconv.Itoa(code)})
	}
}

// traceEvent пишет в удерживаемый host FD даже при замене имени файла.
// Ошибка диагностики не меняет работу адаптера.
func (logs *runtimeLogs) traceEvent(event string, fields map[string]string) {
	if logs.trace == nil {
		return
	}
	fields["ts"], fields["event"] = strconv.FormatInt(time.Now().Unix(), 10), event
	_ = json.NewEncoder(logs.trace).Encode(fields)
}
