package windowsinstall

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const previousDir = "previous"
const installerName = "grigdesk-installer.exe"

// update проверяет новый комплект до любого изменения установки и хранит
// предыдущее поколение для отката. Данные пользователя лежат отдельно и не трогаются.
func update(ctx context.Context, source, destination, local, platform string, key ed25519.PublicKey,
	run func(context.Context, string, string) error) (result error) {
	stagePath, receipt, err := stageVerifiedPackage(source, local, platform, key)
	if err != nil {
		return err
	}
	defer os.RemoveAll(stagePath)

	if err := assertInstalled(destination, key, platform); err != nil {
		return err
	}
	previous := filepath.Join(destination, previousDir)
	if err := os.RemoveAll(previous); err != nil {
		return err
	}
	if err := os.Mkdir(previous, 0700); err != nil {
		return err
	}
	// Резерв предыдущего поколения появляется до замены окна и сервера.
	defer func() {
		if result != nil {
			result = errors.Join(result, restorePrevious(ctx, destination, run))
		}
	}()
	if err := reservePrevious(destination, previous); err != nil {
		return err
	}
	if err := run(ctx, filepath.Join(stagePath, "desktop.exe"), destination); err != nil {
		return fmt.Errorf("windows_desktop_update_failed: %w", err)
	}
	return publishGeneration(destination, stagePath, receipt)
}

// rollback возвращает сохранённое предыдущее поколение тем же NSIS-установщиком.
// Откат возможен только после успешного резерва предыдущего поколения обновлением.
func rollback(ctx context.Context, destination string, key ed25519.PublicKey, platform string,
	run func(context.Context, string, string) error) error {
	if err := assertInstalled(destination, key, platform); err != nil {
		return err
	}
	previous := filepath.Join(destination, previousDir)
	for _, name := range []string{"server", "release.json", installerName} {
		info, err := os.Lstat(filepath.Join(previous, name))
		if err != nil {
			return fmt.Errorf("windows_rollback_generation_invalid: %s", name)
		}
		if name == "server" && !info.IsDir() || name != "server" && !info.Mode().IsRegular() {
			return fmt.Errorf("windows_rollback_generation_invalid: %s", name)
		}
	}
	if err := run(ctx, filepath.Join(previous, installerName), destination); err != nil {
		return fmt.Errorf("windows_desktop_rollback_failed: %w", err)
	}
	if err := os.RemoveAll(filepath.Join(destination, "server")); err != nil {
		return err
	}
	if err := os.Rename(filepath.Join(previous, "server"), filepath.Join(destination, "server")); err != nil {
		return err
	}
	if err := copyRegular(filepath.Join(previous, "release.json"), filepath.Join(destination, "release.json")); err != nil {
		return err
	}
	if err := copyRegular(filepath.Join(previous, installerName), filepath.Join(destination, installerName)); err != nil {
		return err
	}
	return os.RemoveAll(previous)
}

// stageVerifiedPackage повторяет проверки установки: подпись описи, хеши каждого
// компонента и распаковка сервера в отдельный временный корень под LOCALAPPDATA.
func stageVerifiedPackage(source, local, platform string, key ed25519.PublicKey) (string, []byte, error) {
	input, err := os.OpenRoot(source)
	if err != nil {
		return "", nil, err
	}
	defer input.Close()
	record, receipt, err := readManifest(input, key, platform)
	if err != nil {
		return "", nil, err
	}
	stagePath, err := os.MkdirTemp(local, ".grigdesk-update-")
	if err != nil {
		return "", nil, err
	}
	stage, err := os.OpenRoot(stagePath)
	if err != nil {
		os.RemoveAll(stagePath)
		return "", nil, err
	}
	defer stage.Close()
	for _, item := range record.Files {
		if err := copyPayload(input, stage, item); err != nil {
			os.RemoveAll(stagePath)
			return "", nil, err
		}
	}
	if err := unpackServer(filepath.Join(stagePath, "server.zip"), filepath.Join(stagePath, "server")); err != nil {
		os.RemoveAll(stagePath)
		return "", nil, err
	}
	return stagePath, receipt, nil
}

// assertInstalled подтверждает, что каталог является подписанной установкой GrigDesk
// той же платформы. Чужой или неполный каталог не получает обновление и откат.
func assertInstalled(destination string, key ed25519.PublicKey, platform string) error {
	for _, name := range []string{"grigdesk.exe", "server", "release.json"} {
		info, err := os.Lstat(filepath.Join(destination, name))
		if err != nil || (name != "server" && !info.Mode().IsRegular()) {
			return fmt.Errorf("windows_installation_missing: %s", name)
		}
	}
	root, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer root.Close()
	_, _, err = readManifest(root, key, platform)
	return err
}

// reservePrevious переносит текущий сервер и копирует опись с установщиком окна
// в каталог предыдущего поколения. NSIS-установщик нужен для отката самого окна.
func reservePrevious(destination, previous string) error {
	if err := os.Rename(filepath.Join(destination, "server"), filepath.Join(previous, "server")); err != nil {
		return err
	}
	if err := copyRegular(filepath.Join(destination, "release.json"), filepath.Join(previous, "release.json")); err != nil {
		return err
	}
	return copyRegular(filepath.Join(destination, installerName), filepath.Join(previous, installerName))
}

// publishGeneration публикует новое поколение последним шагом: сервер, опись
// и установщик окна появляются после успешной регистрации NSIS.
func publishGeneration(destination, stagePath string, receipt []byte) error {
	if err := os.Rename(filepath.Join(stagePath, "server"), filepath.Join(destination, "server")); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(destination, "release.json"), receipt, 0600); err != nil {
		return err
	}
	return copyRegular(filepath.Join(stagePath, "desktop.exe"), filepath.Join(destination, installerName))
}

// restorePrevious возвращает зарезервированное поколение после отказа обновления.
// Ошибка восстановления добавляется к исходной, чтобы не скрыть причину отказа.
func restorePrevious(ctx context.Context, destination string, run func(context.Context, string, string) error) error {
	previous := filepath.Join(destination, previousDir)
	if _, err := os.Lstat(filepath.Join(previous, installerName)); err != nil {
		return nil
	}
	if err := run(ctx, filepath.Join(previous, installerName), destination); err != nil {
		return fmt.Errorf("windows_update_restore_window_failed: %w", err)
	}
	if err := os.RemoveAll(filepath.Join(destination, "server")); err != nil {
		return err
	}
	if err := os.Rename(filepath.Join(previous, "server"), filepath.Join(destination, "server")); err != nil {
		return err
	}
	if err := copyRegular(filepath.Join(previous, "release.json"), filepath.Join(destination, "release.json")); err != nil {
		return err
	}
	if err := copyRegular(filepath.Join(previous, installerName), filepath.Join(destination, installerName)); err != nil {
		return err
	}
	return os.RemoveAll(previous)
}

// copyRegular копирует обычный файл с перезаписью цели и синхронизацией байтов.
// Ссылки и специальные файлы не копируются, чтобы не вынести данные за корень.
func copyRegular(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("windows_generation_file_invalid: %s", filepath.Base(source))
	}
	raw, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(destination, raw, 0600)
}