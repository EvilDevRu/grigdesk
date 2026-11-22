package windowsinstall

import (
	"archive/zip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

const maxPayload = 768 * 1024 * 1024
const marker = "grigdesk-windows.json"

type fileRecord struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type manifest struct {
	Format   int          `json:"format"`
	Platform string       `json:"platform"`
	Files    []fileRecord `json:"files"`
}

var payloadNames = []string{"grigdesk-maintenance.exe", "desktop.exe", "server.zip"}

// Run поддерживает установку из распакованного локального комплекта Windows.
// Доверенный ключ закреплён при сборке и не приходит из аргументов или окружения.
func Run(ctx context.Context, args []string, trust string) error {
	if len(args) != 3 || args[0] != "install" || runtime.GOOS != "windows" {
		return errors.New("Использование: grigdesk-maintenance.exe install <источник> <каталог установки>")
	}
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	keyBytes, err := base64.StdEncoding.DecodeString(trust)
	if err != nil {
		return errors.New("windows_release_key_invalid")
	}
	decoded, err := x509.ParsePKIXPublicKey(keyBytes)
	key, ok := decoded.(ed25519.PublicKey)
	if err != nil || !ok {
		return errors.New("windows_release_key_invalid")
	}

	release, err := reserveInstallation()
	if err != nil {
		return err
	}
	defer release()

	return install(ctx, args[1], args[2], os.Getenv("LOCALAPPDATA"), "windows-"+arch, key,
		func(ctx context.Context, installer, desktop string) error {
			command := exec.CommandContext(ctx, installer, "/S", "/D="+desktop)
			// NSIS разбирает /D самостоятельно: значение с пробелами должно идти последним без кавычек.
			setInstallerCommandLine(command, installer, desktop)
			command.Stdout, command.Stderr = os.Stdout, os.Stderr
			return command.Run()
		})
}

// readManifest проверяет подпись точных байтов описи до интерпретации файлов.
// Из внешнего JSON берутся только данные, подтверждённые закреплённым ключом.
func readManifest(source *os.Root, key ed25519.PublicKey, platform string) (manifest, []byte, error) {
	var signed struct {
		Payload   []byte `json:"payload"`
		Signature []byte `json:"signature"`
	}
	var record manifest
	raw, err := readRegular(source, "release.json", 64*1024)
	if err != nil {
		return record, nil, err
	}
	if json.Unmarshal(raw, &signed) != nil || !ed25519.Verify(key, signed.Payload, signed.Signature) ||
		json.Unmarshal(signed.Payload, &record) != nil || record.Format != 1 ||
		record.Platform != platform || len(record.Files) != len(payloadNames) {
		return record, nil, errors.New("windows_release_manifest_invalid")
	}
	for index, item := range record.Files {
		hash, err := hex.DecodeString(item.SHA256)
		if item.Name != payloadNames[index] || len(hash) != sha256.Size || err != nil ||
			item.Size < 1 || item.Size > maxPayload {
			return record, nil, errors.New("windows_release_inventory_invalid")
		}
	}
	return record, raw, nil
}

// readRegular читает ограниченный файл через открытый корень и отвергает ссылки.
// Размер проверяется на дескрипторе и после чтения.
func readRegular(root *os.Root, name string, limit int64) ([]byte, error) {
	file, err := openRegular(root, name, limit)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	out, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(out)) > limit {
		return nil, errors.Join(errors.New("windows_release_file_invalid"), err)
	}
	return out, nil
}

// openRegular сопоставляет имя с открытым файлом внутри корня.
// Ссылки и замена имени между lstat и open приводят к отказу.
func openRegular(root *os.Root, name string, limit int64) (*os.File, error) {
	before, err := root.Lstat(name)
	if err != nil || !before.Mode().IsRegular() || before.Size() > limit {
		return nil, errors.Join(errors.New("windows_release_file_invalid"), err)
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !os.SameFile(before, info) || info.Size() > limit || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.Join(errors.New("windows_release_file_invalid"), err)
	}
	return file, nil
}

// copyPayload сверяет именно байты приватной копии, которую запустит установщик.
// Дальнейшее изменение распакованного источника уже не влияет на установку.
func copyPayload(source, stage *os.Root, record fileRecord) error {
	input, err := openRegular(source, record.Name, record.Size)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := stage.OpenFile(record.Name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(input, record.Size+1))
	if err := errors.Join(err, output.Sync(), output.Close()); err != nil {
		return err
	}
	if written != record.Size || hex.EncodeToString(hash.Sum(nil)) != record.SHA256 {
		return fmt.Errorf("windows_release_payload_mismatch: %s", record.Name)
	}
	return nil
}

// install держит право на новый каталог через mkdir. При отказе удаляет
// только собственную неполную установку, а готовность публикует последним шагом.
func install(ctx context.Context, source, destination, local, platform string, key ed25519.PublicKey,
	run func(context.Context, string, string) error) (result error) {
	local, err := filepath.EvalSymlinks(local)
	if err != nil || !filepath.IsAbs(local) || !filepath.IsAbs(destination) || !filepath.IsAbs(source) ||
		filepath.Clean(destination) != destination || strings.ContainsAny(destination, "\"\r\n") {
		return errors.New("windows_install_location_invalid")
	}
	parent := filepath.Dir(destination)
	relative, err := filepath.Rel(local, destination)
	physical, parentErr := filepath.EvalSymlinks(parent)
	if err != nil || parentErr != nil || !strings.EqualFold(parent, physical) ||
		!filepath.IsLocal(relative) || relative == "." ||
		strings.EqualFold(source, destination) {
		return errors.New("windows_install_location_invalid")
	}
	input, err := os.OpenRoot(source)
	if err != nil {
		return err
	}
	defer input.Close()

	record, receipt, err := readManifest(input, key, platform)
	if err != nil {
		return err
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		return fmt.Errorf("windows_install_destination_exists_or_unavailable: %w", err)
	}
	desktopStarted := false
	defer func() {
		if result != nil {
			if desktopStarted {
				if err := undoDesktopInstall(destination); err != nil {
					result = errors.Join(result, fmt.Errorf("windows_install_cleanup_incomplete: %w", err))
					return
				}
			}
			result = errors.Join(result, os.RemoveAll(destination))
		}
	}()
	stagePath, err := os.MkdirTemp(local, ".grigdesk-install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stagePath)
	stage, err := os.OpenRoot(stagePath)
	if err != nil {
		return err
	}
	defer stage.Close()

	for _, item := range record.Files {
		if err := copyPayload(input, stage, item); err != nil {
			return err
		}
	}
	if err := unpackServer(filepath.Join(stagePath, "server.zip"), filepath.Join(stagePath, "server")); err != nil {
		return err
	}
	desktopStarted = true
	if err := run(ctx, filepath.Join(stagePath, "desktop.exe"), destination); err != nil {
		return fmt.Errorf("windows_desktop_install_failed: %w", err)
	}
	if info, err := os.Lstat(filepath.Join(destination, "grigdesk.exe")); err != nil || !info.Mode().IsRegular() {
		return errors.New("windows_desktop_executable_missing")
	}
	if err := os.WriteFile(filepath.Join(destination, "release.json"), receipt, 0600); err != nil {
		return err
	}
	if err := os.Rename(filepath.Join(stagePath, "server"), filepath.Join(destination, "server")); err != nil {
		return err
	}
	return nil
}

// unpackServer извлекает только обычные ZIP-записи в новый физический корень.
// Лимит относится и к общей распаковке, а имена сравниваются без учёта регистра.
func unpackServer(archive, destination string) error {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer reader.Close()
	if err := os.Mkdir(destination, 0700); err != nil {
		return err
	}
	root, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer root.Close()
	seen := make(map[string]bool)
	var size uint64
	for _, entry := range reader.File {
		name := strings.TrimSuffix(entry.Name, "/")
		folded := strings.ToLower(name)
		if !fs.ValidPath(name) || name == "." || strings.ContainsAny(name, "\\:") ||
			!filepath.IsLocal(name) || path.Clean(name) != name || seen[folded] ||
			entry.UncompressedSize64 > maxPayload-size {
			return errors.New("windows_server_archive_invalid")
		}
		seen[folded] = true
		size += entry.UncompressedSize64
		if err := extractEntry(root, name, entry); err != nil {
			return err
		}
	}
	for _, name := range []string{marker, "runtime/node.exe", "bin/factory.exe", "server/src/app.ts"} {
		info, err := root.Lstat(name)
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("windows_server_archive_incomplete: %s", name)
		}
	}
	return nil
}

// extractEntry не допускает ссылок и специальных файлов независимо от способа
// архивирования. O_EXCL не позволяет записи подменить уже извлечённый файл.
func extractEntry(root *os.Root, name string, entry *zip.File) error {
	if entry.Mode().IsDir() {
		return root.MkdirAll(name, 0700)
	}
	if !entry.Mode().IsRegular() {
		return errors.New("windows_server_archive_invalid")
	}
	if err := root.MkdirAll(path.Dir(name), 0700); err != nil {
		return err
	}
	input, err := entry.Open()
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	limit := int64(entry.UncompressedSize64)
	n, err := io.Copy(output, io.LimitReader(input, limit+1))
	if n != limit {
		err = errors.Join(err, errors.New("windows_server_archive_size_mismatch"))
	}
	return errors.Join(err, output.Close())
}
