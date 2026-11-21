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
	"unicode/utf8"

	"golang.org/x/sys/unix"
	"golang.org/x/term"

	"grigdesk.local/tools/shared/i18n"
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
	ctx  context.Context
	fd   int
	out  io.Writer
	lang i18n.CLI
	api  Session
}

type inputExit int

func (exit inputExit) Error() string {
	return "Ввод закрыт."
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
	output, hasOutput := terminal.Stdout.(*os.File)
	if !hasInput || !hasOutput || !term.IsTerminal(int(input.Fd())) || !term.IsTerminal(int(output.Fd())) {
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
	ui := wizard{ctx: ctx, fd: fd, out: terminal.Stdout, api: api, lang: lang}
	err = ui.run(mode, options)
	if err == nil {
		return 0
	}
	var closed inputExit
	if errors.As(err, &closed) {
		return int(closed)
	}
	ui.line(ui.label("requestFailed"))
	return 1
}

func (ui wizard) label(key string) string {
	return ui.lang.Text("remote." + key)
}

func (ui wizard) line(text string) {
	_, _ = fmt.Fprint(ui.out, text, "\r\n")
}

func (ui wizard) next(milliseconds int) (byte, bool, error) {
	for ui.ctx.Err() == nil {
		poll := []unix.PollFd{{Fd: int32(ui.fd), Events: unix.POLLIN}}
		ready, err := unix.Poll(poll, milliseconds)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return 0, false, inputExit(2)
		}
		if ready == 0 {
			return 0, false, nil
		}
		var buffer [1]byte
		n, err := unix.Read(ui.fd, buffer[:])
		if err != nil || n == 0 || buffer[0] == 4 {
			return 0, false, inputExit(2)
		}
		if buffer[0] == 3 {
			return 0, false, inputExit(130)
		}
		return buffer[0], true, nil
	}
	return 0, false, inputExit(130)
}

func (ui wizard) waitByte() (byte, error) {
	for {
		value, ok, err := ui.next(150)
		if err != nil || ok {
			return value, err
		}
	}
}

func (ui wizard) prompt(label string, secret bool, first []byte) (string, error) {
	_, _ = fmt.Fprint(ui.out, ui.label(label), ": ")
	value := append([]byte{}, first...)
	defer func() { clear(value) }()
	for len(value) < 60_000 {
		key, err := ui.waitByte()
		if err != nil {
			return "", err
		}
		switch key {
		case '\r', '\n':
			ui.line("")
			return string(value), nil
		case 27:
			return "", inputExit(2)
		case 8, 127:
			if len(value) != 0 {
				_, size := utf8.DecodeLastRune(value)
				value = value[:len(value)-size]
				if !secret {
					_, _ = io.WriteString(ui.out, "\b \b")
				}
			}
		default:
			if key >= 32 {
				value = append(value, key)
				if !secret {
					_, _ = ui.out.Write([]byte{key})
				}
			}
		}
	}
	return "", inputExit(2)
}

const deployments = "/api/mobile/deployments"

func (ui wizard) run(mode string, options relaySetupArgs) error {
	var status relayAdminStatus
	if err := ui.api.JSON(ui.ctx, http.MethodGet, "/api/mobile/status", nil, &status); err != nil {
		return err
	}
	if status.Server.FP == "" {
		ui.line(ui.label("homeUnavailable"))
		return inputExit(1)
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
	ui.line(ui.label("home") + ": " + Printable(status.Server.Name))
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
	ui.line(ui.label("jobs"))
	for index, job := range matching {
		ui.line(fmt.Sprintf("%d. %s", index+1, jobTitle(job)))
	}
	ui.line("0. " + ui.label("newJob"))
	index, err := ui.readIndex("chooseJob", len(matching), true)
	if err != nil || index == 0 {
		return relayJob{}, err
	}
	return matching[index-1], nil
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

func (ui wizard) readIndex(label string, count int, zero bool) (int, error) {
	value, err := ui.prompt(label, false, nil)
	if err != nil {
		return 0, err
	}
	if value == "" {
		value = "1"
	}
	index, err := strconv.Atoi(value)
	if err != nil || index > count || index < 0 || !zero && index == 0 {
		return 0, inputExit(2)
	}
	return index, nil
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
			return relayJob{}, inputExit(1)
		}
		for index, relay := range status.Relays {
			ui.line(fmt.Sprintf("%d. %s", index+1, Printable(relay.Name)))
		}
		index, err := ui.readIndex("choose", len(status.Relays), false)
		if err != nil {
			return relayJob{}, err
		}
		selected := status.Relays[index-1]
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
		return relayJob{}, inputExit(1)
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
		ui.line(jobTitle(old))
		accept, err := ui.prompt("cancelWaiting", false, nil)
		if err != nil {
			return relayJob{}, err
		}
		if !confirmed(accept) {
			return relayJob{}, inputExit(2)
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
			if _, err = ui.prompt("retry", false, nil); err == nil {
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
			if _, err = ui.prompt(job.State, false, nil); err == nil {
				job, err = ui.action(job, "check", map[string]any{"requestId": requestID()})
			}
		default:
			ui.line(ui.label("working"))
			key, available, readError := ui.next(250)
			if readError != nil {
				return readError
			}
			if available && key == 27 {
				return inputExit(2)
			}
			job, err = ui.request(deployments+"/"+url.PathEscape(job.ID), nil, false)
		}
		if err != nil {
			return err
		}
	}
}

func (ui wizard) reportFailure(job relayJob) {
	code := map[string]string{
		"ssh_auth_failed": "authFailed", "unsupported_platform": "platformFailed", "relay_port_busy": "portBusy",
		"route_conflict": "routeConflict", "previous_installation_restored": "rolledBack",
		"remote_rollback_failed": "rollbackFailed", "deployment_cancelled": "cancelled",
	}[job.Error.Code]
	if code == "" {
		code = "failedGeneric"
	}
	ui.line(ui.label(code))
}

func (ui wizard) trust(job relayJob) (relayJob, error) {
	ui.line(Printable(job.HostKey.Fingerprint))
	replace := job.HostKey.Decision == "replace_required"
	if replace {
		ui.line(ui.label("changedKey"))
	}
	answer, err := ui.prompt("trust", false, nil)
	if err != nil {
		return job, err
	}
	decision := "reject"
	if confirmed(answer) {
		decision = "trust"
		if replace {
			decision = "replace"
		}
	}
	result, err := ui.action(job, "host-key", map[string]any{
		"challengeId": job.HostKey.ChallengeID, "decision": decision,
	})
	if err == nil && decision == "reject" {
		err = inputExit(1)
	}
	return result, err
}

func (ui wizard) credentials(job relayJob) (relayJob, error) {
	ui.line(ui.label("method"))
	useKey := false
	var first []byte
	for {
		key, err := ui.waitByte()
		if err != nil {
			return job, err
		}
		if key == '\r' || key == '\n' {
			break
		}
		if key == 27 {
			prefix, present, err := ui.next(35)
			if err != nil || !present || prefix != '[' {
				return job, inputExit(2)
			}
			arrow, present, err := ui.next(35)
			if err != nil || !present {
				return job, inputExit(2)
			}
			if arrow == 'A' || arrow == 'B' {
				useKey = !useKey
			}
			continue
		}
		if key >= 32 {
			first = []byte{key}
			useKey = false
			break
		}
	}
	data := map[string]any{"attemptId": requestID()}
	if useKey {
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
		clear(first)
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
	for _, change := range job.Preview.Changes {
		if label := changes[change]; label != "" {
			ui.line(ui.label(label))
		} else {
			ui.line(Printable(change))
		}
	}
	answer, err := ui.prompt("start", false, nil)
	if err != nil {
		return job, err
	}
	if !confirmed(answer) {
		return job, inputExit(2)
	}
	return ui.action(job, "start", map[string]any{"requestId": requestID(), "previewDigest": job.Preview.Digest})
}

func (ui wizard) finish(job relayJob) error {
	var pairing Pairing
	if err := ui.api.JSON(ui.ctx, http.MethodPost, "/api/devices/phone-pairing",
		map[string]string{"relayId": job.RelayID}, &pairing); err != nil {
		return err
	}
	ui.line(ui.label("ready"))
	if err := WritePairing(ui.out, pairing, false); err != nil {
		return err
	}
	label := "phonePending"
	if job.RouteUpdateNeeded {
		label = "routeUpdate"
	}
	ui.line(ui.label(label))
	_, _ = ui.waitByte()
	return nil
}
