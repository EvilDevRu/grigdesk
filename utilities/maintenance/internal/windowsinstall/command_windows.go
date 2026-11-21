package windowsinstall

import (
	"errors"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func setInstallerCommandLine(command *exec.Cmd, installer, desktop string) {
	command.SysProcAttr = &syscall.SysProcAttr{CmdLine: `"` + installer + `" /S /D=` + desktop}
}

// reserveInstallation не даёт NSIS автоматически удалить прежнюю установку.
// Windows регистрирует NSIS по стабильному GUID приложения GrigDesk.
func reserveInstallation() (func(), error) {
	const product = `Software\73fd52cc-055b-5e49-89e0-9706aab795e4`
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
			key, err := registry.OpenKey(hive, product, registry.READ|view)
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
