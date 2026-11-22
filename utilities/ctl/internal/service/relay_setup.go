package service

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"

	"grigdesk.local/tools/shared/i18n"
	ctlterm "grigdesk.local/tools/utilities/ctl/internal/terminal"
)

type relaySetupArgs struct {
	SSHPort       int
	PublicPort    int
	PublicHost    string
	CandidateHost string
}

type remoteEndpoint struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type remoteSSH struct {
	remoteEndpoint
	User string `json:"user"`
}

type relayJob struct {
	ID                string         `json:"id"`
	Revision          int            `json:"revision"`
	State             string         `json:"state"`
	Mode              string         `json:"mode"`
	Name              string         `json:"name"`
	RelayID           string         `json:"relayId"`
	Public            remoteEndpoint `json:"public"`
	SSH               remoteSSH      `json:"ssh"`
	RouteUpdateNeeded bool           `json:"routeUpdateRequired"`
	Error             struct {
		Code string `json:"code"`
	} `json:"error"`
	HostKey struct {
		ChallengeID string `json:"challengeId"`
		Decision    string `json:"decision"`
		Fingerprint string `json:"fingerprint"`
	} `json:"hostKey"`
	Preview struct {
		Digest  string   `json:"digest"`
		Changes []string `json:"changes"`
	} `json:"preview"`
}

type relayAdminStatus struct {
	Server struct {
		FP   string `json:"fp"`
		Name string `json:"name"`
	} `json:"server"`
	Relays []struct {
		remoteEndpoint
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"relays"`
}

type wizard struct {
	ctx    context.Context
	input  ctlterm.Input
	screen *ctlterm.Screen
	out    io.Writer
	env    map[string]string
	lang   i18n.CLI
	api    Session
}

func parseRelaySetup(argv []string) (relaySetupArgs, error) {
	args := relaySetupArgs{SSHPort: 22}
	for len(argv) != 0 {
		flag := argv[0]
		switch flag {
		case "--ssh-port", "--public-port", "--public-host", "--candidate-host":
		default:
			return args, errors.New("Неизвестный параметр мастера. Справка: grigdesk-ctl --help")
		}
		if len(argv) < 2 || argv[1] == "" || strings.HasPrefix(argv[1], "--") {
			return args, errors.New("Не указано значение параметра мастера.")
		}
		value := argv[1]
		argv = argv[2:]
		switch flag {
		case "--public-host":
			args.PublicHost = value
		case "--candidate-host":
			args.CandidateHost = value
		default:
			port, err := strconv.Atoi(value)
			if err != nil || port < 1 || port > 65535 {
				return args, errors.New("Порт должен быть от 1 до 65535.")
			}
			if flag == "--ssh-port" {
				args.SSHPort = port
			} else {
				args.PublicPort = port
			}
		}
	}
	return args, nil
}

// SetupRelay использует серверное задание через локальную административную сессию.
// Секрет читается без эха и передаётся только в binary-запросе credentials.
func SetupRelay(ctx context.Context, settings Settings, mode string, argv []string, terminal Terminal) int {
	options, invalid := parseRelaySetup(argv)
	if invalid != nil {
		return terminal.Fail(invalid.Error(), 2)
	}
	lang := i18n.CLIForEnvironment(settings.Env)
	input, hasInput := terminal.Stdin.(*os.File)
	if !hasInput || !ctlterm.IsTTY(input) || !ctlterm.IsTTY(terminal.Stdout) {
		return terminal.Fail(lang.Text("remote.tty"), 2)
	}
	api, err := SignIn(ctx, settings)
	if err != nil {
		return terminal.Fail(lang.Text("remote.sessionUnavailable"), 1)
	}
	fd := int(input.Fd())
	restore, err := term.MakeRaw(fd)
	if err != nil {
		return terminal.Fail(lang.Text("remote.tty"), 2)
	}
	defer term.Restore(fd, restore)
	screen := terminal.Screen
	if screen == nil {
		standalone := ctlterm.NewScreen(terminal.Stdout, settings.Env)
		screen = &standalone
	}
	ui := wizard{
		ctx: ctx, input: ctlterm.Input{Ctx: ctx, FD: fd, Out: terminal.Stdout},
		screen: screen, out: terminal.Stdout,
		env: settings.Env, api: api, lang: lang,
	}
	err = ui.run(mode, options)
	if err == nil {
		return 0
	}
	var closed ctlterm.Exit
	if errors.As(err, &closed) {
		if closed == ctlterm.EndOfInput {
			return 2
		}
		return int(closed)
	}
	ui.line(ui.screen.Label(ui.label("requestFailed"), ctlterm.Error))
	return 1
}

func (ui wizard) label(key string) string {
	return ui.lang.Text("remote." + key)
}

func (ui wizard) line(text string) {
	_, _ = fmt.Fprint(ui.out, text, "\r\n")
}

func (ui wizard) prompt(label string, secret bool, first []byte) (string, error) {
	title := ui.screen.Label(ui.label(label)+":", ctlterm.Accent)
	return ui.input.Text(title+" ", secret, first, 60_000)
}

// pick даёт мастеру те же строки и управление, что у основного меню.
// Текстовые сокращения остаются доступны для привычных сценариев.
func (ui wizard) pick(choice ctlterm.Choice) (int, error) {
	choice.Navigation = ui.lang.Text("navigation")
	choice.Paging = ui.lang.Text("choice.paging")
	return ui.screen.Choose(ui.input, choice)
}

// decision начинает с отказа и сохраняет прежний ответ «да» с клавиатуры.
// Подробности операции видны рядом с вариантами выбора.
func (ui wizard) decision(label, action string, details []string) (bool, error) {
	chosen, err := ui.pick(ctlterm.Choice{
		Title: ui.label(label), Details: details,
		Options: []string{ui.lang.Text("choice.decline"), ui.lang.Text(action)},
		Shortcut: func(first byte) (int, error) {
			answer, err := ui.input.Text("", true, []byte{first}, 128)
			if confirmed(answer) {
				return 1, err
			}
			return 0, err
		},
	})
	return chosen == 1, err
}

const deployments = "/api/mobile/deployments"

func (ui wizard) run(mode string, options relaySetupArgs) error {
	var status relayAdminStatus
	if err := ui.api.JSON(ui.ctx, http.MethodGet, "/api/mobile/status", nil, &status); err != nil {
		return err
	}
	if status.Server.FP == "" {
		ui.line(ui.label("homeUnavailable"))
		return ctlterm.Exit(1)
	}
	var listed struct {
		Jobs []relayJob `json:"jobs"`
	}
	if err := ui.api.JSON(ui.ctx, http.MethodGet, deployments, nil, &listed); err != nil {
		return err
	}
	if status.Server.Name == "" {
		status.Server.Name = ui.api.Origin
	}
	ui.line(ui.screen.Label(ui.label("home")+": "+Printable(status.Server.Name), ctlterm.Accent))
	job, err := ui.choose(mode, listed.Jobs)
	if err != nil {
		return err
	}
	if job.ID == "" {
		job, err = ui.create(mode, options, status, listed.Jobs)
		if err != nil {
			return err
		}
	}
	return ui.drive(job)
}

func (ui wizard) choose(mode string, jobs []relayJob) (relayJob, error) {
	var matching []relayJob
	for _, job := range jobs {
		if job.Mode == mode && job.State != "ready" {
			matching = append(matching, job)
		}
	}
	if len(matching) == 0 {
		return relayJob{}, nil
	}
	options := make([]string, 0, len(matching)+1)
	for _, job := range matching {
		options = append(options, jobTitle(job))
	}
	options = append(options, ui.label("newJob"))
	index, err := ui.readIndex("chooseJob", options, true)
	if err != nil || index == len(matching) {
		return relayJob{}, err
	}
	return matching[index], nil
}

func jobTitle(job relayJob) string {
	name := job.Name
	if name == "" {
		name = job.Public.Host
	}
	if name == "" {
		name = job.ID
	}
	return Printable(name) + " · " + Printable(job.SSH.Host)
}

// readIndex сохраняет ввод номера рядом с навигацией стрелками.
// В списке заданий номер 0 ведёт на создание нового задания в конце списка.
func (ui wizard) readIndex(label string, options []string, allowNew bool) (int, error) {
	return ui.pick(ctlterm.Choice{
		Title: ui.label(label), Options: options,
		Shortcut: func(first byte) (int, error) {
			value, err := ui.input.Text("", true, []byte{first}, 12)
			if err != nil {
				return -1, err
			}
			index, err := strconv.Atoi(value)
			switch {
			case err != nil || index < 0 || index > len(options):
				return -1, ctlterm.Exit(2)
			case index == 0 && allowNew:
				return len(options) - 1, nil
			case index > 0 && (!allowNew || index < len(options)):
				return index - 1, nil
			default:
				return -1, ctlterm.Exit(2)
			}
		},
	})
}

func (ui wizard) create(mode string, options relaySetupArgs, status relayAdminStatus, previous []relayJob) (relayJob, error) {
	body := struct {
		RequestID        string         `json:"requestId"`
		ExpectedServerFP string         `json:"expectedServerFp"`
		Mode             string         `json:"mode"`
		Name             string         `json:"name,omitempty"`
		RelayID          string         `json:"relayId,omitempty"`
		SSH              remoteSSH      `json:"ssh"`
		Public           remoteEndpoint `json:"public"`
		CandidateHost    string         `json:"candidateHost"`
	}{RequestID: requestID(), ExpectedServerFP: status.Server.FP, Mode: mode}
	if mode == "restore" {
		if len(status.Relays) == 0 {
			ui.line(ui.label("noRelay"))
			return relayJob{}, ctlterm.Exit(1)
		}
		names := make([]string, 0, len(status.Relays))
		for _, relay := range status.Relays {
			names = append(names, Printable(relay.Name))
		}
		index, err := ui.readIndex("choose", names, false)
		if err != nil {
			return relayJob{}, err
		}
		selected := status.Relays[index]
		body.RelayID, body.Public = selected.ID, selected.remoteEndpoint
	} else {
		name, err := ui.prompt("name", false, nil)
		if err != nil {
			return relayJob{}, err
		}
		body.Name = name
	}
	var err error
	if body.SSH.Host, err = ui.prompt("host", false, nil); err != nil {
		return relayJob{}, err
	}
	if body.SSH.User, err = ui.prompt("user", false, nil); err != nil {
		return relayJob{}, err
	}
	body.SSH.Port = options.SSHPort
	if options.PublicHost == "" && strings.Contains(body.SSH.Host, ":") {
		ui.line(ui.label("publicRequired"))
		return relayJob{}, ctlterm.Exit(1)
	}
	if body.Public.Host == "" {
		body.Public = remoteEndpoint{Host: body.SSH.Host, Port: 443}
	}
	if options.PublicHost != "" {
		body.Public.Host = options.PublicHost
	}
	if options.PublicPort != 0 {
		body.Public.Port = options.PublicPort
	}
	body.CandidateHost = options.CandidateHost
	if body.CandidateHost == "" {
		body.CandidateHost = body.SSH.Host
	}
	for _, old := range previous {
		if !canCancelRelay(old.State) || (body.RelayID == "" || body.RelayID != old.RelayID) &&
			body.Public != old.Public {
			continue
		}
		accept, err := ui.decision("cancelWaiting", "remote.cancelWaitingAction", []string{jobTitle(old)})
		if err != nil {
			return relayJob{}, err
		}
		if !accept {
			return relayJob{}, ctlterm.Exit(2)
		}
		if _, err := ui.action(old, "cancel", map[string]any{"requestId": requestID()}); err != nil {
			return relayJob{}, err
		}
	}
	return ui.request(deployments, body, false)
}

func canCancelRelay(state string) bool {
	switch state {
	case "draft", "awaiting_host_key", "awaiting_credentials", "awaiting_confirmation":
		return true
	}
	return false
}

func confirmed(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "да", "yes", "y":
		return true
	default:
		return false
	}
}

func requestID() string {
	return strings.ReplaceAll(rand.Text(), "=", "")
}

func (ui wizard) action(job relayJob, action string, data map[string]any) (relayJob, error) {
	if data == nil {
		data = make(map[string]any)
	}
	data["revision"] = job.Revision
	if action == "probe" {
		ui.api.Timeout = 25 * time.Second
	}
	return ui.request(deployments+"/"+url.PathEscape(job.ID)+"/"+action, data, action == "credentials")
}

func (ui wizard) request(path string, data any, binary bool) (relayJob, error) {
	var reply json.RawMessage
	if binary {
		body, err := json.Marshal(data)
		if err != nil {
			return relayJob{}, err
		}
		defer clear(body)
		reply, err = ui.api.Request(ui.ctx, http.MethodPost, path, "application/octet-stream", body)
		if err != nil {
			return relayJob{}, err
		}
	} else {
		method := http.MethodGet
		if data != nil {
			method = http.MethodPost
		}
		if err := ui.api.JSON(ui.ctx, method, path, data, &reply); err != nil {
			return relayJob{}, err
		}
	}
	var result struct {
		Job *relayJob `json:"job"`
		relayJob
	}
	if err := json.Unmarshal(reply, &result); err != nil {
		return relayJob{}, err
	}
	if result.Job != nil {
		result.relayJob = *result.Job
	}
	if result.ID == "" || result.Revision < 1 || result.State == "" {
		return relayJob{}, errors.New("Пустой ответ мастера.")
	}
	return result.relayJob, nil
}

func (ui wizard) drive(job relayJob) error {
	for {
		var err error
		switch job.State {
		case "draft":
			job, err = ui.action(job, "probe", nil)
		case "failed", "interrupted", "recovery_required":
			ui.reportFailure(job)
			if err = ui.acknowledge("retry", "choice.retry"); err == nil {
				job, err = ui.action(job, "retry", map[string]any{"requestId": requestID()})
			}
		case "awaiting_host_key":
			job, err = ui.trust(job)
		case "awaiting_credentials":
			job, err = ui.credentials(job)
		case "awaiting_confirmation":
			job, err = ui.confirm(job)
		case "ready":
			return ui.finish(job)
		case "awaiting_dns", "waiting_vpn":
			if err = ui.acknowledge(job.State, "choice.check"); err == nil {
				job, err = ui.action(job, "check", map[string]any{"requestId": requestID()})
			}
		default:
			job, err = ui.waitForJob(job)
		}

		if err != nil {
			return err
		}
	}
}

func (ui wizard) acknowledge(label, action string) error {
	_, err := ui.pick(ctlterm.Choice{Title: ui.label(label), Options: []string{ui.lang.Text(action)}})
	return err
}

// waitForJob обновляет строку ожидания до изменения статуса серверного задания.
// Esc закрывает наблюдение, а само задание продолжает выполняться на сервере.
func (ui wizard) waitForJob(job relayJob) (relayJob, error) {
	progress := ctlterm.NewProgress(ui.out, ui.env, true)
	defer progress.Close()
	progress.Update(ui.label("working"), "", 0, 0)

	state := job.State
	for job.State == state {
		key, available, err := ui.input.Read(250)
		if err != nil {
			return job, err
		}
		if available && key == 27 {
			return job, ctlterm.Exit(2)
		}
		job, err = ui.request(deployments+"/"+url.PathEscape(job.ID), nil, false)
		if err != nil {
			return job, err
		}
	}
	return job, nil
}

func (ui wizard) reportFailure(job relayJob) {
	code := map[string]string{
		"ssh_auth_failed": "authFailed", "unsupported_platform": "platformFailed", "relay_port_busy": "portBusy",
		"route_conflict": "routeConflict", "deployment_cancelled": "cancelled",
	}[job.Error.Code]
	if code == "" {
		code = "failedGeneric"
	}
	ui.line(ui.screen.Label(ui.label(code), ctlterm.Error))
}

func (ui wizard) trust(job relayJob) (relayJob, error) {
	details := []string{Printable(job.HostKey.Fingerprint)}
	replace := job.HostKey.Decision == "replace_required"
	if replace {
		details = append(details, ui.label("changedKey"))
	}
	answer, err := ui.decision("trust", "remote.trustAction", details)
	if err != nil {
		return job, err
	}
	decision := "reject"
	if answer {
		decision = "trust"
		if replace {
			decision = "replace"
		}
	}
	result, err := ui.action(job, "host-key", map[string]any{
		"challengeId": job.HostKey.ChallengeID, "decision": decision,
	})
	if err == nil && decision == "reject" {
		err = ctlterm.Exit(1)
	}
	return result, err
}

func (ui wizard) credentials(job relayJob) (relayJob, error) {
	var first []byte
	method, err := ui.pick(ctlterm.Choice{
		Title:   ui.label("method"),
		Options: []string{ui.label("password"), ui.label("keyMethod")},
		Shortcut: func(key byte) (int, error) {
			first = []byte{key}
			return 0, nil
		},
	})
	defer clear(first)
	if err != nil {
		return job, err
	}

	data := map[string]any{"attemptId": requestID()}
	if method == 1 {
		file, err := ui.prompt("keyFile", false, nil)
		if err != nil {
			return job, err
		}
		handle, err := os.Open(file)
		if err != nil {
			return job, err
		}
		bytes, err := io.ReadAll(io.LimitReader(handle, 60_001))
		_ = handle.Close()
		defer clear(bytes)
		if err != nil || len(bytes) > 60_000 {
			return job, errors.New("Приватный ключ слишком велик или недоступен.")
		}
		passphrase, err := ui.prompt("passphrase", true, nil)
		if err != nil {
			return job, err
		}
		data["privateKey"], data["passphrase"] = string(bytes), passphrase
	} else {
		password, err := ui.prompt("password", true, first)
		if err != nil {
			return job, err
		}
		data["password"] = password
	}
	return ui.action(job, "credentials", data)
}

func (ui wizard) confirm(job relayJob) (relayJob, error) {
	changes := map[string]string{"install_relay_binary": "changeBinary", "create_service_user": "changeUser",
		"write_private_config": "changeConfig", "enable_systemd": "changeService"}
	details := make([]string, 0, len(job.Preview.Changes))
	for _, change := range job.Preview.Changes {
		if label := changes[change]; label != "" {
			details = append(details, ui.label(label))
		} else {
			details = append(details, Printable(change))
		}
	}
	answer, err := ui.decision("start", "choice.accept", details)
	if err != nil {
		return job, err
	}
	if !answer {
		return job, ctlterm.Exit(2)
	}
	return ui.action(job, "start", map[string]any{"requestId": requestID(), "previewDigest": job.Preview.Digest})
}

func (ui wizard) finish(job relayJob) error {
	var pairing Pairing
	if err := ui.api.JSON(ui.ctx, http.MethodPost, "/api/devices/phone-pairing",
		map[string]string{"relayId": job.RelayID}, &pairing); err != nil {
		return err
	}
	ui.line(ui.screen.Label(ui.label("ready"), ctlterm.Success))
	if err := WritePairing(ui.out, pairing, false); err != nil {
		return err
	}
	label := "phonePending"
	if job.RouteUpdateNeeded {
		label = "routeUpdate"
	}
	ui.line(ui.label(label))
	_, _ = ui.input.Byte()
	return nil
}
