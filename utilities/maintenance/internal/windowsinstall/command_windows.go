package windowsinstall

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const productKey = `Software\73fd52cc-055b-5e49-89e0-9706aab795e4`

func setInstallerCommandLine(command *exec.Cmd, installer, desktop string) {
	command.SysProcAttr = &syscall.SysProcAttr{CmdLine: `"` + installer + `" /S /D=` + desktop}
}

// reserveInstallation не даёт NSIS автоматически удалить прежнюю установку.
// Windows регистрирует NSIS по стабильному GUID приложения GrigDesk.
func reserveInstallation() (func(), error) {
	name, err := windows.UTF16PtrFromString(`Local\GrigDesk-native-install`)
	if err != nil {
		return nil, err
	}
	lock, err := windows.CreateMutex(nil, false, name)
	release := func() {
		if lock != 0 {
			windows.CloseHandle(lock)
		}
	}
	if err != nil {
		release()
		return nil, errors.Join(errors.New("windows_install_already_running"), err)
	}
	for _, hive := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		for _, view := range []uint32{registry.WOW64_32KEY, registry.WOW64_64KEY} {
			key, err := registry.OpenKey(hive, productKey, registry.READ|view)
			if err == nil {
				key.Close()
				release()
				return nil, errors.New("windows_install_registration_exists")
			}
			if !errors.Is(err, registry.ErrNotExist) {
				release()
				return nil, err
			}
		}
	}
	return release, nil
}

// undoDesktopInstall снимает регистрацию, появившуюся у этой установки.
// NSIS с _?= завершается в исходном процессе, после чего каталог можно удалить.
func undoDesktopInstall(destination string) error {
	registered := false
	for _, view := range []uint32{registry.WOW64_32KEY, registry.WOW64_64KEY} {
		key, err := registry.OpenKey(registry.CURRENT_USER, productKey, registry.QUERY_VALUE|view)
		if errors.Is(err, registry.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		location, _, err := key.GetStringValue("InstallLocation")
		key.Close()
		if err != nil || !strings.EqualFold(location, destination) {
			return errors.New("windows_install_unexpected_registration")
		}
		registered = true
	}
	if !registered {
		return nil
	}
	uninstaller := filepath.Join(destination, "Uninstall grigdesk.exe")
	info, err := os.Lstat(uninstaller)
	if err != nil || !info.Mode().IsRegular() {
		return errors.Join(errors.New("windows_install_uninstaller_unavailable"), err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, uninstaller)
	command.SysProcAttr = &syscall.SysProcAttr{
		CmdLine: `"` + uninstaller + `" /currentuser /S _?=` + destination,
	}
	return command.Run()
}
