package route

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadCurrentBundle(t *testing.T) {
	root := t.TempDir()
	routes := filepath.Join(root, "routes")
	pins := publishFixture(t, routes)
	reader := BundleReader{dir: routes, profile: "demo-profile"}
	t.Run("published", func(t *testing.T) {
		catalog, err := reader.ReadCurrent()
		if err != nil {
			t.Fatal(err)
		}
		if catalog.Hash != pins.CatalogHash || catalog.Routes["debug"] != pins.RouteHash {
			t.Fatalf("неверные закрепления каталога: %+v", catalog)
		}
	})

	profile := filepath.Join(routes, "demo-profile")
	revision := filepath.Join(profile, "debug", "revisions", pins.RouteHash)
	prompt := filepath.Join(revision, "prompts", "instrument.base.md")
	promptBytes, err := os.ReadFile(prompt)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("changed_prompt", func(t *testing.T) {
		corrupt := append([]byte(nil), promptBytes...)
		corrupt[0] ^= 1
		replaceFixtureFile(t, prompt, corrupt)
		expectRejected(t, reader, "содержимое не совпадает с manifest")
	})
	t.Run("symlink", func(t *testing.T) {
		foreign := filepath.Join(root, "prompt.md")
		if err := os.WriteFile(foreign, promptBytes, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(prompt); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = os.Remove(prompt)
			if err := os.WriteFile(prompt, promptBytes, 0600); err != nil {
				t.Error(err)
			}
		})
		if err := os.Symlink(foreign, prompt); err != nil {
			t.Fatal(err)
		}
		expectRejected(t, reader, "файл недоступен")
	})
	t.Run("extra_file", func(t *testing.T) {
		extra := filepath.Join(revision, "extra")
		if err := os.WriteFile(extra, []byte("extra"), 0600); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := os.Remove(extra); err != nil {
				t.Error(err)
			}
		})
		expectRejected(t, reader, "фактический набор файлов")
	})
	t.Run("foreign_catalog", func(t *testing.T) {
		catalogDir := filepath.Join(profile, "catalog")
		foreign := strings.Repeat("0", 64)
		catalog := filepath.Join(catalogDir, "revisions", pins.CatalogHash)
		wrongAddress := filepath.Join(catalogDir, "revisions", foreign)
		if err := os.CopyFS(wrongAddress, os.DirFS(catalog)); err != nil {
			t.Fatal(err)
		}
		pointer := []byte("{\n  \"catalogHash\": \"" + foreign + "\",\n  \"schema\": 2\n}\n")
		replaceFixtureFile(t, filepath.Join(catalogDir, "current.json"), pointer)
		expectRejected(t, reader, "hash manifest не совпадает")

		pinned, err := reader.ReadCatalog(pins.CatalogHash)
		if err != nil || pinned.Hash != pins.CatalogHash {
			t.Fatalf("чтение закрепления из revisions: catalog=%+v err=%v", pinned, err)
		}
	})
}

type fixturePins struct {
	CatalogHash string `json:"catalogHash"`
	RouteHash   string `json:"routeHash"`
}

// publishFixture использует штатный серверный publisher для тестовых бандлов.
// Любой сбой подготовки прерывает тест до проверки кандидата.
func publishFixture(t *testing.T, dir string) fixturePins {
	t.Helper()
	publisher := filepath.Join("..", "..", "..", "..", "tests", "engine", "fixtures", "routes-publish.mjs")
	cmd := exec.Command("node", publisher, dir, "Диагностика", "null")
	var diagnostic strings.Builder
	cmd.Stderr = &diagnostic
	data, err := cmd.Output()
	if err != nil {
		t.Fatalf("фикстура publisher: %v\n%s", err, diagnostic.String())
	}

	var pins fixturePins
	if err := json.Unmarshal(data, &pins); err != nil || pins.CatalogHash == "" || pins.RouteHash == "" {
		t.Fatalf("фикстура publisher не вернула закрепления: %q, %v", data, err)
	}
	return pins
}

// replaceFixtureFile восстанавливает исходные байты после одной проверки порчи.
// Изменяется только временная копия, которую создал publishFixture.
func replaceFixtureFile(t *testing.T, path string, data []byte) {
	t.Helper()
	old, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.WriteFile(path, old, 0600); err != nil {
			t.Error(err)
		}
	})
}

// expectRejected проверяет именно диагностическую причину отказа.
// Общая заглушка чтения не должна проходить отрицательный кейс.
func expectRejected(t *testing.T, reader BundleReader, expected string) {
	t.Helper()
	if _, err := reader.ReadCurrent(); err == nil || !strings.Contains(err.Error(), expected) {
		t.Errorf("ожидался отказ %q, получен %v", expected, err)
	}
}
