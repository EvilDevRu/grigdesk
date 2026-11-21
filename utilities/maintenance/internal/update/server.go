package update

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/internal/grigdeskapi"
	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/internal/installation"
	"grigdesk.local/tools/utilities/internal/processidentity"
)

type serverOwner struct {
	InstallationID string  `json:"installationId"`
	InstanceID     string  `json:"instanceId"`
	PackageID      string  `json:"packageId"`
	Version        string  `json:"productVersion"`
	PID            int     `json:"pid"`
	Binary         string  `json:"binary"`
	Owner          string  `json:"owner"`
	Process        Process `json:"process"`
}

type serverActivity struct {
	Active int      `json:"active"`
	Queued int      `json:"queued"`
	Tasks  []string `json:"tasks"`
}

func serverOrigin(receipt installation.Receipt) (string, error) {
	path := filepath.Join(receipt.DataHome, ".env")
	data, err := installation.ReadOrdinary(path, 1<<20)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	port := localapi.ParseDotenv(string(data))["GRIGDESK_PORT"]
	if port == "" {
		port = "8140"
	}
	number, err := strconv.ParseUint(port, 10, 16)
	if err != nil || number == 0 {
		return "", errors.New("release_server_port_invalid")
	}
	return "http://127.0.0.1:" + strconv.FormatUint(number, 10), nil
}

func serverRequest(ctx context.Context, layout *installation.Layout, method, route string,
	input any, expected int, output any) error {
	receipt := layout.Receipt
	connection, err := localapi.ResolveConnection(map[string]string{"GRIGDESK_HOME": receipt.DataHome}, localapi.ConfigIO{
		GetHome: func() string {
			value, _ := os.UserHomeDir()
			return value
		},
		ReadText: func(file string) (string, error) {
			data, err := installation.ReadOrdinary(file, 1<<20)
			return string(data), err
		},
	})
	if err != nil {
		return errors.New("release_server_token_unreadable")
	}
	origin, err := serverOrigin(receipt)
	if err != nil {
		return err
	}
	headers := http.Header{"X-Grigdesk-Token": {connection.Token}, "Accept": {"application/json"}}
	var body []byte
	if input != nil {
		body, err = json.Marshal(input)
		if err != nil {
			return err
		}
		headers.Set("Content-Type", "application/json")
	}
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	response, err := grigdeskapi.Request(bounded, method, origin+route, body, grigdeskapi.Policy{
		Header: headers, ReadLimit: limitedServerResponse,
	})
	if err != nil || response.Truncated {
		return errors.New("release_server_request_failed")
	}
	if response.Status != expected {
		var result struct {
			Error string `json:"error"`
		}
		if response.Status == http.StatusConflict && json.Unmarshal(response.Body, &result) == nil {
			switch result.Error {
			case "release_activity_unknown", "release_drain_busy", "release_task_cleanup_required":
				return errors.New(result.Error)
			}
		}
		return errors.New("release_server_request_failed")
	}
	if output != nil && json.Unmarshal(response.Body, output) != nil {
		return errors.New("release_server_response_invalid")
	}
	return nil
}

func limitedServerResponse(int, http.Header) int64 {
	return 1 << 20
}

func inspectServer(ctx context.Context, layout *installation.Layout, selected *string) (*serverOwner, error) {
	if selected == nil {
		return nil, nil
	}
	origin, err := serverOrigin(layout.Receipt)
	if err != nil {
		return nil, err
	}
	bounded, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	_, err = grigdeskapi.Request(bounded, http.MethodGet, origin+"/api/health", nil, grigdeskapi.Policy{})
	if errors.Is(err, syscall.ECONNREFUSED) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("release_server_owner_invalid")
	}
	var server serverOwner
	if err := serverRequest(ctx, layout, http.MethodGet, "/api/system/runtime-identity", nil, 200, &server); err != nil {
		return nil, err
	}
	manifest, err := layout.Manifest(*selected, "server")
	binary := filepath.Join(layout.Receipt.Root, *selected, "bin", "grigdesk-server")
	if err != nil || server.InstallationID != layout.Receipt.InstallationID ||
		!uuid.MatchString(server.InstanceID) || server.Version != manifest.Version ||
		server.PackageID != manifest.Artifacts["server"].PackageID || server.Binary != binary {
		return nil, errors.New("release_server_owner_invalid")
	}
	process, err := observeProcess(ctx, server.PID)
	if err != nil || !verifyServerProcess(layout, server, process, binary) {
		return nil, errors.New("release_server_owner_invalid")
	}
	server.Process = process
	return &server, nil
}

func verifyServerProcess(layout *installation.Layout, server serverOwner, process Process, binary string) bool {
	if process.Executable == binary {
		return true
	}
	var marker struct {
		Process Process `json:"process"`
	}
	data, err := layout.ReadPrivate("update/server-process.json")
	if err != nil || json.Unmarshal(data, &marker) != nil || marker.Process.Executable != binary {
		return false
	}
	birth, dead := processidentity.Start(marker.Process.PID)
	return !dead && birth == marker.Process.Starttime &&
		processParent(server.PID) == marker.Process.PID
}

func activity(ctx context.Context, layout *installation.Layout) (serverActivity, error) {
	var chats struct {
		Active []json.RawMessage `json:"active"`
		Queued []json.RawMessage `json:"queued"`
	}
	if err := serverRequest(ctx, layout, http.MethodGet, "/api/chat/active", nil, 200, &chats); err != nil ||
		chats.Active == nil || chats.Queued == nil {
		return serverActivity{}, errors.New("release_activity_unknown")
	}
	var tasks struct {
		Tasks []struct {
			ID          json.RawMessage `json:"task"`
			DaemonAlive *bool           `json:"daemonAlive"`
			ReadOnly    bool            `json:"readOnly"`
		} `json:"tasks"`
	}
	if err := serverRequest(ctx, layout, http.MethodGet, "/api/tasks", nil, 200, &tasks); err != nil ||
		tasks.Tasks == nil {
		return serverActivity{}, errors.New("release_activity_unknown")
	}
	state := serverActivity{Active: len(chats.Active), Queued: len(chats.Queued), Tasks: []string{}}
	for _, task := range tasks.Tasks {
		if task.DaemonAlive == nil || !*task.DaemonAlive || task.ReadOnly {
			continue
		}
		var id string
		if json.Unmarshal(task.ID, &id) != nil {
			id = string(task.ID)
		}
		if number, err := strconv.ParseUint(id, 10, 53); err != nil || number == 0 {
			return serverActivity{}, errors.New("release_activity_unknown")
		}
		state.Tasks = append(state.Tasks, id)
	}
	return state, nil
}

func startServer(ctx context.Context, layout *installation.Layout, selected *string, wait bool) error {
	if selected == nil {
		return errors.New("installation_component_missing")
	}
	root := layout.Receipt.Root
	unlock, err := installation.AcquireLock(filepath.Join(root, "update", "server-launch.install-lock"))
	if err != nil {
		return errors.New("release_server_start_busy")
	}
	defer unlock()
	current, err := inspectServer(ctx, layout, selected)
	if err != nil || current != nil {
		return err
	}
	started, err := startPlatformService(ctx, layout)
	if err != nil {
		return err
	}
	if !started {
		name := filepath.Join(root, "update", "maintenance")
		binary, err := layout.Maintenance()
		if err != nil {
			return err
		}
		defer binary.Close()
		log, err := os.OpenFile(filepath.Join(root, "update", "server.log"),
			os.O_APPEND|os.O_WRONLY|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
		if err != nil {
			return err
		}
		defer log.Close()
		command := exec.Command(name, "launch", "server")
		command.Dir = root
		command.Stdout, command.Stderr = log, log
		command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := command.Start(); err != nil {
			return err
		}
		_ = command.Process.Release()
	}
	if !wait {
		return nil
	}
	deadline, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	for {
		owner, err := inspectServer(deadline, layout, selected)
		if err == nil && owner != nil {
			return nil
		}
		if !pauseUntil(deadline, 300*time.Millisecond) {
			return errors.New("release_server_start_timeout")
		}
	}
}

func pauseUntil(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// RegisterServerLaunch закрепляет PID до exec того же процесса в выбранный бинарник.
func RegisterServerLaunch(layout *installation.Layout, executable string) error {
	pid := os.Getpid()
	start, dead := processidentity.Start(pid)
	if dead || start == "" {
		return errors.New("release_server_owner_invalid")
	}
	identity := Process{PID: pid, Starttime: start, Executable: executable}
	content, err := installation.JSONBytes(map[string]any{"process": identity})
	if err != nil {
		return err
	}
	return installation.ReplaceState(filepath.Join(layout.Receipt.Root, "update", "server-process.json"), content)
}

// StartServer запускает подтверждённую роль текущей установки.
func StartServer(ctx context.Context, layout *installation.Layout, pointer installation.Pointer, wait bool) error {
	return startServer(ctx, layout, pointer.Server, wait)
}

// StopServer завершает подтверждённого владельца текущей регистрации.
func StopServer(ctx context.Context, layout *installation.Layout, pointer installation.Pointer) error {
	owner, err := inspectServer(ctx, layout, pointer.Server)
	if err != nil || owner == nil {
		return err
	}
	switch owner.Owner {
	case "service":
		if err := stopPlatformService(ctx, layout); err != nil {
			return err
		}
	case "manual", "desktop":
		if err := stopManualProcess(ctx, owner.Process); err != nil {
			return err
		}
	default:
		return errors.New("release_server_owner_invalid")
	}
	bounded, cancel := context.WithTimeout(ctx, 65*time.Second)
	defer cancel()
	for {
		start, dead := processidentity.Start(owner.PID)
		if dead || start != "" && start != owner.Process.Starttime {
			current, err := inspectServer(bounded, layout, pointer.Server)
			if err != nil || current != nil {
				return errors.New("release_server_still_running")
			}
			return nil
		}
		if !pauseUntil(bounded, 200*time.Millisecond) {
			return errors.New("release_server_stop_timeout")
		}
	}
}

// ServerStatus показывает только подтверждённую инкарнацию службы текущего корня.
func ServerStatus(ctx context.Context, layout *installation.Layout, pointer installation.Pointer) (any, error) {
	owner, err := inspectServer(ctx, layout, pointer.Server)
	if err != nil {
		return nil, err
	}
	state := "stopped"
	if owner != nil {
		state = "ready"
	}
	return map[string]any{"state": state, "running": owner != nil, "instance": owner}, nil
}

// ServerLogs выбирает журнал проверенной пользовательской службы или файл этой установки.
func ServerLogs(ctx context.Context, layout *installation.Layout, pointer installation.Pointer,
	lines int, follow bool, stdout io.Writer) error {
	if pointer.Server == nil {
		return errors.New("installation_component_missing")
	}
	if _, err := layout.Manifest(*pointer.Server, "server"); err != nil {
		return err
	}
	command, err := serverJournal(ctx, layout, strconv.Itoa(lines), follow)
	if err != nil {
		return err
	}
	if command == nil {
		name := filepath.Join(layout.Receipt.Root, "update", "server.log")
		if err := installation.CheckParents(filepath.Dir(name)); err != nil {
			return err
		}
		file, err := os.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			return err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("release_server_log_invalid")
		}
		args := []string{"-n", strconv.Itoa(lines)}
		if follow {
			args = append(args, "-f")
		}
		command = exec.CommandContext(ctx, "/usr/bin/tail", args...)
		command.Stdin = file
	}
	command.Stdout, command.Stderr = stdout, os.Stderr
	return command.Run()
}
