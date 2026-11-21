package cli

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"
	"slices"
	"sync"
	"time"

	"grigdesk.local/tools/utilities/internal/buildinfo"
	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/relay/internal/managed"
	"grigdesk.local/tools/utilities/relay/internal/protocol"
	"grigdesk.local/tools/utilities/relay/internal/supervisor"
	"grigdesk.local/tools/utilities/relay/internal/tunnel"
)

//go:embed help.txt
var help string

const kind = "grigdesk-relay"

type Command struct {
	Version string
}

// Run разделяет локальные flags, health и два режима управляемого процесса.
// Неизвестные аргументы не попадают в журналы.
func (command Command) Run(
	ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer,
) int {
	if code, handled := buildinfo.Local(stdout, args, kind, command.Version, true); handled {
		return code
	}
	if slices.Equal(args, []string{"--help"}) || slices.Equal(args, []string{"-h"}) {
		_, _ = io.WriteString(stdout, help)
		return 0
	}
	env := localapi.ProcessEnv()
	switch {
	case slices.Equal(args, []string{"--healthcheck"}):
		if err := tunnel.Health(ctx, env); err != nil {
			return 1
		}
		return 0
	case slices.Equal(args, []string{"--worker"}):
		return worker(ctx, env, stdout, stderr)
	case len(args) == 0:
		duration, err := tunnel.Watchdog(env)
		if err != nil {
			return 2
		}
		self, err := os.Executable()
		if err != nil {
			return 1
		}
		return supervisor.Run(ctx, self, stdout, stderr, duration)
	default:
		_, _ = fmt.Fprintln(stderr, "Неизвестная команда. Справка: grigdesk-relay --help")
		return 2
	}
}

// worker принимает IPC до конфигурации и запускает heartbeat только после bind.
// Диагностика содержит фиксированные события без адресов, токенов и id соединений.
func worker(parent context.Context, env map[string]string, stdout, stderr io.Writer) int {
	ctx, channel, err := supervisor.Worker(parent)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Внутренний режим запускает сам посредник.")
		return 2
	}
	defer channel.Close()
	log := logger(stdout)
	config, err := tunnel.ReadConfig(env)
	if err != nil {
		log("configuration_error", 0)
		return 2
	}
	proof, err := managed.Read(config)
	if err != nil {
		log("deployment_gate_rejected", 0)
		return 2
	}
	startup := func() { go channel.Heartbeat(ctx) }
	if err := tunnel.Serve(ctx, config, log, proof, startup); err != nil {
		log("configuration_error", 0)
		return 2
	}
	return 0
}

// logger сериализует сообщения разных соединений через общий writer.
// Безопасные поля совпадают с контрактом текущей диагностики процесса.
func logger(out io.Writer) tunnel.Logger {
	var lock sync.Mutex
	return func(event string, port int) {
		lock.Lock()
		defer lock.Unlock()
		_ = protocol.Write(out, struct {
			TS   int64  `json:"ts"`
			Ev   string `json:"ev"`
			Port int    `json:"port,omitempty"`
		}{TS: time.Now().UnixMilli(), Ev: event, Port: port})
	}
}
