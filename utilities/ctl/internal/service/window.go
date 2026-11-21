package service

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func windowApp(settings Settings) string {
	if settings.Portable {
		return filepath.Join(settings.Root, "GrigDesk")
	}
	return filepath.Join(settings.Root, "bin", "grigdesk-app")
}

func executable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

func windowDataDir(settings Settings) string {
	if explicit := settings.Env["GRIGDESK_DESKTOP_DATA_DIR"]; filepath.IsAbs(explicit) {
		return explicit
	}
	config := settings.Env["XDG_CONFIG_HOME"]
	if config == "" {
		config = filepath.Join(settings.Home, ".config")
	}
	return filepath.Join(config, "GrigDesk")
}

// ReadWindow принимает только живой локальный SingletonLock.
func ReadWindow(settings Settings) WindowState {
	lock, _ := os.Readlink(filepath.Join(windowDataDir(settings), "SingletonLock"))
	if split := strings.LastIndexByte(lock, '-'); split > 0 {
		host, _ := os.Hostname()
		pid, err := strconv.Atoi(lock[split+1:])
		if lock[:split] == host && pid > 0 && err == nil {
			probe := syscall.Kill(pid, 0)
			if probe == nil || errors.Is(probe, syscall.EPERM) {
				return WindowState{State: "open"}
			}
		}
	}
	if executable(windowApp(settings)) {
		return WindowState{State: "closed"}
	}
	return WindowState{State: "not_installed"}
}

func WindowStartsServer(settings Settings) bool {
	if settings.Portable {
		return true
	}
	data := settings.Env["XDG_DATA_HOME"]
	if data == "" {
		data = filepath.Join(settings.Home, ".local", "share")
	}
	content, err := os.ReadFile(filepath.Join(data, "grigdesk", "desktop", "runtime.json"))
	if err != nil {
		return false
	}
	var descriptor struct {
		Version int    `json:"version"`
		Root    string `json:"root"`
		Node    string `json:"node"`
		Server  string `json:"server"`
	}
	if json.Unmarshal(content, &descriptor) != nil {
		return false
	}
	switch descriptor.Version {
	case 1:
		return filepath.IsAbs(descriptor.Root) && filepath.IsAbs(descriptor.Node)
	case 2:
		return filepath.IsAbs(descriptor.Root) || filepath.IsAbs(descriptor.Server)
	default:
		return false
	}
}

// OpenWindow передаёт из .env только явный путь к ключу окна.
func OpenWindow(settings Settings, term Terminal) int {
	if settings.Env["DISPLAY"] == "" && settings.Env["WAYLAND_DISPLAY"] == "" {
		return term.Fail("Нет графического сеанса", 1)
	}
	app := windowApp(settings)
	if !executable(app) {
		return term.Fail("Окно GrigDesk не установлено: grigdesk-ctl desktop install", 1)
	}
	var argv []string
	if !settings.Portable {
		argv = append(argv, "--grigdesk-url="+settings.Origin+"/")
	}
	command := exec.Command(app, argv...)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if settings.WindowKey != "" {
		command.Env = append(os.Environ(), "GRIGDESK_WINDOW_KEY_PATH="+settings.WindowKey)
	}
	if err := command.Start(); err != nil {
		return term.Fail(err.Error(), 1)
	}
	_ = command.Process.Release()
	return term.Say("Окно открывается")
}
