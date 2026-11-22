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
	"strings"
	"testing"
)

// packageFixture создаёт подписанный тестовый комплект без рабочего Electron.
// Файлы и zip проходят настоящие проверки установщика.
func packageFixture(t *testing.T, invalidEntry string) (string, ed25519.PublicKey) {
	t.Helper()
	source := t.TempDir()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	for _, name := range []string{marker, "runtime/node.exe", "bin/factory.exe", "server/src/app.ts", invalidEntry} {
		if name == "" {
			continue
		}
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	record := manifest{Format: 1, Platform: "windows-x64"}
	for index, name := range payloadNames {
		raw := []byte(name)
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
	return source, public
}

func TestInstallPublishesServerAfterVerifiedDesktop(t *testing.T) {
	source, key := packageFixture(t, "")
	local := t.TempDir()
	destination := filepath.Join(local, "GrigDesk Install")
	run := func(_ context.Context, executable, app string) error {
		raw, err := os.ReadFile(executable)
		if err != nil || string(raw) != "desktop.exe" || app != destination {
			t.Fatalf("неверный запуск установщика: %s, %v", app, err)
		}
		if _, err := os.Stat(filepath.Join(app, "server", marker)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("пакет объявлен готовым до установки окна: %v", err)
		}
		return os.WriteFile(filepath.Join(app, "grigdesk.exe"), []byte("fixture"), 0600)
	}
	if err := install(t.Context(), source, destination, local, "windows-x64", key, run); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"grigdesk.exe", "release.json", "server/runtime/node.exe", "server/" + marker} {
		if _, err := os.Stat(filepath.Join(destination, name)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInstallRejectsCorruptPayloadAndArchiveTraversal(t *testing.T) {
	for _, label := range []string{"tamper", "escape", "casefold", "architecture"} {
		t.Run(label, func(t *testing.T) {
			platform := "windows-x64"
			entry := ""
			switch label {
			case "escape":
				entry = "../outside.txt"
			case "casefold":
				entry = "RUNTIME/NODE.EXE"
			case "architecture":
				platform = "windows-arm64"
			}
			source, key := packageFixture(t, entry)
			if label == "tamper" {
				if err := os.WriteFile(filepath.Join(source, "desktop.exe"), []byte("desktop.EXE"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			local := t.TempDir()
			destination := filepath.Join(local, "Application")
			err := install(t.Context(), source, destination, local, platform, key,
				func(context.Context, string, string) error {
					t.Fatal("непроверенный исполняемый файл передан на запуск")
					return nil
				})
			if err == nil {
				t.Fatal("изменённая поставка принята")
			}
			if entries, err := os.ReadDir(local); err != nil || len(entries) != 0 {
				t.Fatalf("после отказа остались файлы: %v, %v", entries, err)
			}
		})
	}
}

func TestInstallPreservesExistingDestinationAndCleansFailedRun(t *testing.T) {
	source, key := packageFixture(t, "")
	local := t.TempDir()
	destination := filepath.Join(local, "installed")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	userFile := filepath.Join(destination, "existing.txt")
	if err := os.WriteFile(userFile, []byte("existing data"), 0600); err != nil {
		t.Fatal(err)
	}
	called := false
	run := func(context.Context, string, string) error {
		called = true
		return errors.New("fixture failure")
	}
	err := install(t.Context(), source, destination, local, "windows-x64", key, run)
	if err == nil || called {
		t.Fatalf("существующая установка изменена: %v", err)
	}
	if raw, err := os.ReadFile(userFile); err != nil || string(raw) != "existing data" {
		t.Fatal("существующий файл потерян")
	}
	failure := filepath.Join(local, "new app")
	err = install(t.Context(), source, failure, local, "windows-x64", key, run)
	if !called || err == nil || !strings.Contains(err.Error(), "fixture failure") {
		t.Fatalf("ошибка установки потеряна: %v", err)
	}
	if _, err := os.Stat(failure); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("остался неполный каталог: %v", err)
	}
}
