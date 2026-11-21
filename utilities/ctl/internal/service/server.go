package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/internal/grigdeskapi"
)

const Unit = "grigdesk-server.service"
const unitProperties = "--property=LoadState,ActiveState,SubState,Result,WorkingDirectory"

type ServerState struct {
	State   string  `json:"state"`
	Managed *bool   `json:"managed"`
	URL     string  `json:"url"`
	Reason  *string `json:"reason"`
}

type Action struct {
	Name   string
	Lines  int
	Follow bool
	Wait   bool
}

func reason(text string) *string {
	if text == "" {
		return nil
	}
	value := Printable(text)
	return &value
}

func managed(value bool) *bool {
	return &value
}

func readUnit(ctx context.Context) map[string]string {
	output := Query(ctx, 5*time.Second, "systemctl", "--user", "show", Unit, unitProperties)
	if output.Code != 0 {
		return nil
	}
	fields := make(map[string]string)
	for _, line := range strings.Split(output.Stdout, "\n") {
		if key, value, found := strings.Cut(line, "="); found {
			fields[key] = value
		}
	}
	return fields
}

func probe(ctx context.Context, origin string) string {
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	response, err := grigdeskapi.Request(bounded, http.MethodGet, origin+"/api/auth/state", nil,
		grigdeskapi.Policy{ReadLimit: func(int, http.Header) int64 { return 256 << 10 }})
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "refused"
	}
	if err != nil || bounded.Err() != nil {
		return "no_answer"
	}
	if response.Status != 200 || response.Truncated {
		return "other"
	}
	var state struct {
		Configured    *bool `json:"configured"`
		Authenticated *bool `json:"authenticated"`
	}
	if err := json.Unmarshal(response.Body, &state); err != nil ||
		state.Configured == nil || state.Authenticated == nil {
		return "other"
	}
	return "grigdesk"
}

// ReadServer одновременно спрашивает systemd и читает схему readiness.
func ReadServer(ctx context.Context, settings Settings) ServerState {
	return readServer(ctx, settings, true)
}

// ReadMenuServer даёт короткую пробу для шапки и не запрашивает журнал.
func ReadMenuServer(ctx context.Context, settings Settings) ServerState {
	bounded, cancel := context.WithTimeout(ctx, 700*time.Millisecond)
	defer cancel()
	return readServer(bounded, settings, false)
}

func readServer(ctx context.Context, settings Settings, includeJournal bool) ServerState {
	listening := make(chan string, 1)
	go func() { listening <- probe(ctx, settings.Origin) }()
	unit := readUnit(ctx)
	answer := <-listening
	gate := ""
	if includeJournal && unit["ActiveState"] == "activating" {
		result := Query(ctx, 10*time.Second, "journalctl", "--user", "-u", Unit, "-n", "50", "-o", "cat", "--no-pager")
		if result.Code == 0 {
			gate = gateReason(result.Stdout)
		}
	}
	state := derive(unit, answer, settings.ServerWork, gate)
	state.URL = settings.Origin + "/"
	return state
}

func gateReason(log string) string {
	var last string
	for line := range strings.SplitSeq(log, "\n") {
		if explanation, ok := strings.CutPrefix(line, "VPN-ворота: "); ok {
			last = explanation
		}
	}
	if gate, forbidden := strings.CutSuffix(last, " — запуск запрещён"); forbidden {
		return "ждёт VPN: " + gate
	}
	return ""
}

// derive воспроизводит таблицу статусов, включая работу ручного сервера вне службы.
func derive(unit map[string]string, answer, expected, gate string) ServerState {
	status := func(state string, owner *bool, details string) ServerState {
		return ServerState{State: state, Managed: owner, Reason: reason(details)}
	}
	yes, no := managed(true), managed(false)
	ready, refused := answer == "grigdesk", answer == "refused"
	if unit == nil {
		if ready {
			return status("ready", nil, "systemd недоступен — служба не проверена")
		}
		return status("unknown", nil, "systemd недоступен")
	}
	const conflict = "порт занят другой программой"
	switch unit["LoadState"] {
	case "not-found":
		if ready {
			return status("ready", no, "работает вне службы")
		}
		if refused {
			return status("not_installed", no, "служба не установлена: deploy/install.sh --no-autostart")
		}
		return status("conflict", no, conflict)
	case "loaded":
		if unit["WorkingDirectory"] != expected {
			return status("mismatch", no, "служба указывает на другую копию: "+unit["WorkingDirectory"])
		}
	default:
		return status("mismatch", nil, "служба в состоянии "+unit["LoadState"])
	}
	switch active := unit["ActiveState"]; active {
	case "active":
		switch answer {
		case "grigdesk":
			return status("ready", yes, "")
		case "refused":
			return status("starting", yes, "процесс запущен, порт ещё не открыт")
		case "no_answer":
			return status("not_responding", yes, "не отвечает на проверку")
		default:
			return status("conflict", yes, conflict)
		}
	case "activating", "reloading":
		if ready {
			return status("conflict", no, "порт держит ручной запуск, служба не может стартовать")
		}
		return status("starting", yes, gate)
	case "deactivating":
		return status("stopping", yes, "")
	case "inactive", "failed":
		if ready {
			return status("ready", no, "работает вне службы, служба остановлена")
		}
		if !refused {
			return status("conflict", no, conflict)
		}
		if active == "failed" {
			return status("failed", yes, "служба упала: "+unit["Result"])
		}
		return status("stopped", yes, "")
	default:
		return status("unknown", nil, "неизвестное состояние "+active)
	}
}

// Server выполняет только действие над установленной службой этой копии.
func Server(ctx context.Context, settings Settings, action Action, term Terminal) int {
	if action.Name == "logs" {
		return serverLogs(ctx, settings, action, term)
	}
	status := ReadServer(ctx, settings)
	if action.Name == "start" {
		switch status.State {
		case "ready":
			return term.Say("Сервер уже работает")
		case "starting":
			term.Say("Сервер уже запускается")
			if action.Wait {
				return waitForServer(ctx, settings, term)
			}
			return 0
		case "not_responding":
			return term.Fail("Сервер не отвечает: grigdesk-ctl server restart", 1)
		}
	}
	if status.State == "ready" && status.Managed != nil && !*status.Managed {
		return term.Fail("Сервер работает вне службы (приложение GrigDesk или ручной запуск); systemd им не управляет", 1)
	}
	switch status.State {
	case "conflict", "not_installed", "mismatch", "unknown":
		return term.Fail(textOr(status.Reason, "Служба сервера недоступна для управления"), 1)
	}
	if status.Managed == nil || !*status.Managed {
		return term.Fail(textOr(status.Reason, "Служба сервера недоступна для управления"), 1)
	}
	if action.Name == "stop" {
		switch status.State {
		case "stopped":
			return term.Say("Сервер уже остановлен")
		case "stopping":
			return term.Say("Сервер уже останавливается")
		}
	}
	argv := []string{"--user", action.Name, Unit}
	timeout := 120 * time.Second
	if action.Name == "start" {
		argv = []string{"--user", "start", "--no-block", Unit}
		timeout = 10 * time.Second
	} else {
		verb := map[string]string{"stop": "Останавливаю", "restart": "Перезапускаю"}
		_, _ = fmt.Fprintf(term.Stderr, "%s сервер: идущим ходам агентов дают закончить (до 45 с)…\n", verb[action.Name])
	}
	result := Query(ctx, timeout, "systemctl", argv...)
	if result.Code != 0 {
		return term.Fail(textOr(reason(strings.TrimSpace(result.Stderr)), "systemd отказал в выполнении команды"), 1)
	}
	term.Say(map[string]string{"start": "Запуск сервера запрошен", "stop": "Сервер остановлен",
		"restart": "Сервер перезапущен"}[action.Name])
	if action.Wait {
		return waitForServer(ctx, settings, term)
	}
	return 0
}

func serverLogs(ctx context.Context, settings Settings, action Action, term Terminal) int {
	unit := readUnit(ctx)
	if unit["LoadState"] == "not-found" {
		log := settings.Env["GRIGDESK_LOG"]
		if log == "" {
			log = filepath.Join(settings.DataHome, "state", "grigdesk-server.log")
		}
		return term.Fail("Служба сервера не установлена; журнал ручного запуска: "+log, 1)
	}
	status := derive(unit, "refused", settings.ServerWork, "")
	if unit == nil || unit["LoadState"] != "loaded" || status.State == "mismatch" {
		return term.Fail(textOr(status.Reason, "systemd недоступен"), 1)
	}
	argv := []string{"--user", "-u", Unit, "-n", strconv.Itoa(action.Lines), "--no-pager"}
	if action.Follow {
		argv = append(argv, "-f")
	}
	return term.Attached(ctx, "journalctl", argv...)
}

func waitForServer(ctx context.Context, settings Settings, term Terminal) int {
	seconds, _ := strconv.ParseFloat(settings.Env["GRIGDESK_WAIT_SEC"], 64)
	if seconds == 0 {
		seconds = 90
	}
	deadline := time.Now().Add(time.Duration(seconds * float64(time.Second)))
	for {
		state := ReadServer(ctx, settings)
		switch state.State {
		case "ready":
			return term.Say("Сервер работает")
		case "failed":
			return term.Fail(textOr(state.Reason, "Служба упала"), 1)
		}
		if time.Now().After(deadline) {
			return term.Fail(fmt.Sprintf("Сервер не ответил за %g с. %s", seconds,
				strings.TrimSpace(render(Snapshot{Server: &state}, false))), 3)
		}
		select {
		case <-ctx.Done():
			return 130
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func textOr(text *string, fallback string) string {
	if text != nil && *text != "" {
		return *text
	}
	return fallback
}

// InAgentScope определяет принадлежность запуска службе или scope окна до внешних эффектов.
func InAgentScope(env map[string]string) bool {
	file := env["GRIGDESK_CLI_CGROUP_FILE"]
	if file == "" {
		file = "/proc/self/cgroup"
	}
	snapshot, _ := os.ReadFile(file)
	for line := range strings.SplitSeq(string(snapshot), "\n") {
		_, tail, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		_, path, found := strings.Cut(tail, ":")
		if !found {
			continue
		}
		for part := range strings.SplitSeq(path, "/") {
			if part == Unit {
				return true
			}
			pid, ok := strings.CutPrefix(part, "app-grigdesk-")
			if !ok {
				continue
			}
			pid, ok = strings.CutSuffix(pid, ".scope")
			if _, err := strconv.ParseUint(pid, 10, 64); ok && err == nil {
				return true
			}
		}
	}
	return false
}
