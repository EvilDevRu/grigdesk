package windowsinstall

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// releaseKey создаёт одну пару ключей выпуска для всех поколений теста.
// Реальные выпуски подписаны одним ключом, поэтому проверка доверяет ему же.
func releaseKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return public, private
}

// versionedPackage собирает подписанный комплект с различимым содержимым сервера
// и окна. Версия попадает в server/version.txt и в байты NSIS-установщика.
func versionedPackage(t *testing.T, version string, public ed25519.PublicKey, private ed25519.PrivateKey) string {
	t.Helper()
	source := t.TempDir()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	for _, name := range []string{marker, "runtime/node.exe", "bin/factory.exe", "server/src/app.ts", "version.txt"} {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		content := name
		if name == "version.txt" {
			content = version
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	record := manifest{Format: 1, Platform: "windows-x64"}
	for index, name := range payloadNames {
		raw := []byte(name)
		if index == 1 {
			raw = []byte("desktop-" + version)
		}
		if index == 2 {
			raw = buffer.Bytes()
		}
		hash := sha256.Sum256(raw)
		record.Files = append(record.Files, fileRecord{Name: name, Size: int64(len(raw)), SHA256: hex.EncodeToString(hash[:])})
		if err := os.WriteFile(filepath.Join(source, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	payload, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(map[string][]byte{"payload": payload, "signature": ed25519.Sign(private, payload)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "release.json"), envelope, 0600); err != nil {
		t.Fatal(err)
	}
	return source
}

// windowRun имитирует NSIS: окно получает байты запущенного установщика.
// Так тест различает, какое поколение окна установилось после операции.
func windowRun(t *testing.T) func(context.Context, string, string) error {
	t.Helper()
	return func(_ context.Context, installer, app string) error {
		raw, err := os.ReadFile(installer)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(app, "grigdesk.exe"), raw, 0600)
	}
}

func readVersion(t *testing.T, destination string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(destination, "server", "version.txt"))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func installVersion(t *testing.T, source, destination, local string, key ed25519.PublicKey) {
	t.Helper()
	if err := install(t.Context(), source, destination, local, "windows-x64", key, windowRun(t)); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateSwapsGenerationAndRollbackRestoresIt(t *testing.T) {
	key, private := releaseKey(t)
	sourceA := versionedPackage(t, "A", key, private)
	sourceB := versionedPackage(t, "B", key, private)
	local := t.TempDir()
	destination := filepath.Join(local, "GrigDesk")
	dataHome := filepath.Join(local, "Data")
	if err := os.Mkdir(dataHome, 0700); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(dataHome, "keep.txt")
	if err := os.WriteFile(keep, []byte("user data"), 0600); err != nil {
		t.Fatal(err)
	}
	installVersion(t, sourceA, destination, local, key)
	if readVersion(t, destination) != "A" {
		t.Fatal("исходное поколение не A")
	}

	if err := update(t.Context(), sourceB, destination, local, "windows-x64", key, windowRun(t)); err != nil {
		t.Fatal(err)
	}
	if readVersion(t, destination) != "B" {
		t.Fatal("обновление не сменило поколение")
	}
	if raw, err := os.ReadFile(filepath.Join(destination, "previous", "server", "version.txt")); err != nil || string(raw) != "A" {
		t.Fatalf("предыдущее поколение не зарезервировано: %v", err)
	}
	if raw, err := os.ReadFile(keep); err != nil || string(raw) != "user data" {
		t.Fatal("пользовательские данные потеряны при обновлении")
	}

	if err := rollback(t.Context(), destination, key, "windows-x64", windowRun(t)); err != nil {
		t.Fatal(err)
	}
	if readVersion(t, destination) != "A" {
		t.Fatal("откат не вернул поколение A")
	}
	if _, err := os.Stat(filepath.Join(destination, "previous")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("после отката остался резерв")
	}
	if raw, err := os.ReadFile(keep); err != nil || string(raw) != "user data" {
		t.Fatal("пользовательские данные потеряны при откате")
	}
}

func TestUpdateRejectsCorruptPackageWithoutTouchingInstall(t *testing.T) {
	key, private := releaseKey(t)
	sourceA := versionedPackage(t, "A", key, private)
	sourceB := versionedPackage(t, "B", key, private)
	local := t.TempDir()
	destination := filepath.Join(local, "GrigDesk")
	installVersion(t, sourceA, destination, local, key)
	if err := update(t.Context(), sourceB, destination, local, "windows-x64", key, windowRun(t)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceB, "desktop.exe"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	err := update(t.Context(), sourceB, destination, local, "windows-x64", key,
		func(context.Context, string, string) error {
			t.Fatal("повреждённый пакет дошёл до запуска установщика")
			return nil
		})
	if err == nil {
		t.Fatal("повреждённый пакет принят")
	}
	if readVersion(t, destination) != "B" {
		t.Fatal("отказ повреждённого пакета изменил установленное поколение")
	}
	if raw, err := os.ReadFile(filepath.Join(destination, "previous", "server", "version.txt")); err != nil || string(raw) != "A" {
		t.Fatal("отказ повредил резерв предыдущего поколения")
	}
}

func TestUpdateRestoresPreviousWhenWindowInstallFails(t *testing.T) {
	key, private := releaseKey(t)
	sourceA := versionedPackage(t, "A", key, private)
	sourceB := versionedPackage(t, "B", key, private)
	local := t.TempDir()
	destination := filepath.Join(local, "GrigDesk")
	installVersion(t, sourceA, destination, local, key)
	failing := func(_ context.Context, installer, app string) error {
		raw, err := os.ReadFile(installer)
		if err != nil {
			return err
		}
		if string(raw) == "desktop-B" {
			return errors.New("fixture window failure")
		}
		return os.WriteFile(filepath.Join(app, "grigdesk.exe"), raw, 0600)
	}
	err := update(t.Context(), sourceB, destination, local, "windows-x64", key, failing)
	if err == nil {
		t.Fatal("отказ окна не остановил обновление")
	}
	if readVersion(t, destination) != "A" {
		t.Fatal("после отказа окно не вернулось к поколению A")
	}
	if _, err := os.Stat(filepath.Join(destination, "previous")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("после восстановления остался резерв")
	}
}