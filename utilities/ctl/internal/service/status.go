package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

type WindowState struct {
	State string `json:"state"`
}

type Snapshot struct {
	Server *ServerState `json:"server,omitempty"`
	Window *WindowState `json:"window,omitempty"`
	Relay  *RelayState  `json:"relay,omitempty"`
}

// Status печатает состояние сервера, окна и зарегистрированных связей.
// Отдельный статус связей проверяет HTTP сервера без опроса локальных служб.
func Status(ctx context.Context, settings Settings, selection string, jsonOutput, color bool, term Terminal) int {
	var snapshot Snapshot
	var ready bool
	if selection == "relay" {
		ready = probe(ctx, settings.Origin) == "grigdesk"
	} else {
		server := ReadServer(ctx, settings)
		snapshot.Server = &server
		ready = server.State == "ready"
	}
	if selection == "status" {
		window := ReadWindow(settings)
		snapshot.Window = &window
	}
	if selection != "server" {
		relay := RelayState{}
		if ready {
			relay.Links = readLinks(ctx, settings)
		}
		snapshot.Relay = &relay
	}
	if jsonOutput {
		encoder := json.NewEncoder(term.Stdout)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(snapshot); err != nil {
			return term.Fail(err.Error(), 1)
		}
		return 0
	}
	_, _ = fmt.Fprint(term.Stdout, render(snapshot, color))
	return 0
}

type word struct {
	text  string
	color int
}

var serverWords = map[string]word{
	"ready": {"Работает", 32}, "starting": {"Запускается", 33}, "stopping": {"Останавливается", 33},
	"unknown": {"Неизвестно", 33}, "not_responding": {"Не отвечает", 31}, "failed": {"Упал", 31},
	"conflict": {"Конфликт порта", 31}, "mismatch": {"Чужая служба", 31}, "stopped": {"Остановлен", 2},
	"not_installed": {"Не установлен", 2},
}
var windowWords = map[string]word{
	"open": {"Открыто", 32}, "closed": {"Закрыто", 2}, "not_installed": {"Не установлено", 2},
	"unknown": {"Неизвестно", 33},
}
var linkWords = map[string]string{
	"online": "на связи", "connecting": "подключается", "waiting_vpn": "ждёт VPN",
	"offline": "нет связи", "error": "ошибка", "unknown": "неизвестно",
}

func row(label string, word word, detail string, color bool) string {
	icon := "●"
	switch word.color {
	case 2:
		icon = "○"
	case 33:
		icon = "◐"
	}
	status := icon + " " + word.text
	status += strings.Repeat(" ", max(1, 20-utf8.RuneCountInString(status)))
	if color {
		status = fmt.Sprintf("\x1b[%dm%s\x1b[0m", word.color, status)
	}
	return strings.TrimRight(fmt.Sprintf("  %-12s%s%s", label, status, detail), " ")
}

func render(snapshot Snapshot, color bool) string {
	var lines, hints []string
	if snapshot.Server != nil && snapshot.Window != nil && snapshot.Relay != nil {
		lines = append(lines, "GrigDesk", "")
	}
	if server := snapshot.Server; server != nil {
		fallback := ""
		if server.State == "ready" {
			fallback = server.URL
		}
		lines = append(lines, row("Сервер", serverWords[server.State], textOr(server.Reason, fallback), color))
		switch server.State {
		case "stopped":
			hints = append(hints, "Запустить: grigdesk-ctl server start")
		case "not_installed":
			hints = append(hints, "Установить службу: deploy/install.sh --no-autostart")
		case "failed":
			hints = append(hints, "Запустить: grigdesk-ctl server start", "Журнал: grigdesk-ctl server logs")
		case "not_responding":
			hints = append(hints, "Журнал: grigdesk-ctl server logs")
		case "starting":
			if server.Reason != nil {
				hints = append(hints, "Журнал: grigdesk-ctl server logs")
			}
		}
	}
	if window := snapshot.Window; window != nil {
		lines = append(lines, row("Окно", windowWords[window.State], "", color))
		switch window.State {
		case "closed":
			hints = append(hints, "Открыть: grigdesk-ctl open")
		case "not_installed":
			hints = append(hints, "Установить окно: grigdesk-ctl desktop install")
		}
	}
	if relay := snapshot.Relay; relay != nil {
		state := "сведения недоступны"
		if relay.Links != nil {
			state = "нет настроенных посредников"
			if len(relay.Links) > 0 {
				links := make([]string, len(relay.Links))
				for index, link := range relay.Links {
					links[index] = link.Name + " — " + linkWords[link.State]
				}
				state = strings.Join(links, "; ")
			}
		}
		lines = append(lines, "  Связи: "+state)
	}
	if len(hints) > 0 {
		lines = append(lines, "", "  "+strings.Join(hints, "\n  "))
	}
	return strings.Join(lines, "\n") + "\n"
}
