package state

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const historicalAttemptID = "a_11111111111111111111111111111111"

type historicalFixture struct {
	store             Store
	routes            string
	catalog, route    string
	active, completed string
}

func TestAttemptReadHistorical(t *testing.T) {
	fixture := seedHistoricalAttempt(t)
	before := stateFixtureHashes(t, fixture.store.ControlDir)
	attempt, err := fixture.store.ReadAttempt("51", fixture.active)
	if err != nil {
		t.Fatal(err)
	}
	if attempt.ID != fixture.active || attempt.Profile != "demo-profile" ||
		attempt.CatalogHash != fixture.catalog || attempt.RouteID != "debug" ||
		attempt.RouteHash != fixture.route || attempt.Terminal != "" {
		t.Fatalf("потеряна метаинформация попытки: %+v", attempt)
	}
	closed, err := fixture.store.ReadAttempt("52", fixture.completed)
	if err != nil {
		t.Fatal(err)
	}
	if closed.ID != fixture.completed || closed.Terminal != "finished" || closed.RouteHash != fixture.route {
		t.Fatalf("потеряно запечатанное завершение: %+v", closed)
	}
	after := stateFixtureHashes(t, fixture.store.ControlDir)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("чтение изменило доверенное дерево: до=%d после=%d", len(before), len(after))
	}
}

// seedHistoricalAttempt раскладывает байты, снятые со старого движка на двух синтетических задачах.
// Живой путь к локальному bundle подставляется в attempt.json и отдельно хешируется.
func seedHistoricalAttempt(t *testing.T) historicalFixture {
	t.Helper()
	repo, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	physical, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fixture := historicalFixture{
		store: Store{
			ControlDir: filepath.Join(physical, "control"), StateDir: filepath.Join(physical, "state"),
		},
		routes: filepath.Join(physical, "routes"), active: historicalAttemptID,
		completed: "a_22222222222222222222222222222222",
	}
	for _, dir := range []string{fixture.store.ControlDir, fixture.store.StateDir} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	publisher := filepath.Join(repo, "tests", "engine", "fixtures", "routes-publish.mjs")
	published := historicalProcess(t, "node", publisher, fixture.routes, "Исторический маршрут", "null")
	var pins struct {
		Catalog string `json:"catalogHash"`
		Route   string `json:"routeHash"`
	}
	if err := json.Unmarshal(published, &pins); err != nil || pins.Catalog == "" || pins.Route == "" {
		t.Fatalf("фикстура не опубликовала pins: %s (%v)", published, err)
	}
	fixture.catalog, fixture.route = pins.Catalog, pins.Route
	installHistoricalFiles(t, "attempts.json", fixture.store.ControlDir, fixture.routes)
	attempt := filepath.Join(fixture.store.ControlDir, "protocol-v2", "tasks", "t51", "attempts", fixture.active)
	if err := os.Mkdir(filepath.Join(attempt, "stage-results"), 0700); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func historicalInput(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "historical", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// installHistoricalFiles разворачивает исторические байты с их правилами доступа.
// Перемещаемый маршрут затрагивает только checksum двух immutable attempt.json.
func installHistoricalFiles(t *testing.T, name, target, routes string) {
	t.Helper()
	files := map[string]struct {
		Mode os.FileMode `json:"mode"`
		Text string      `json:"text"`
	}{}
	if err := json.Unmarshal(historicalInput(t, name), &files); err != nil || len(files) == 0 {
		t.Fatalf("неверная историческая фикстура %s: %v", name, err)
	}

	for relative, item := range files {
		if !filepath.IsLocal(relative) {
			t.Fatalf("неверный путь фикстуры: %s", relative)
		}
		data := strings.ReplaceAll(item.Text, "@ROUTES@", routes)
		if strings.HasSuffix(relative, "/attempt.sha256") {
			attempt := files[strings.TrimSuffix(relative, ".sha256")+".json"]
			payload := strings.ReplaceAll(attempt.Text, "@ROUTES@", routes)
			data = fmt.Sprintf("%x\n", sha256.Sum256([]byte(payload)))
		}
		file := filepath.Join(target, relative)
		if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(data), item.Mode); err != nil {
			t.Fatal(err)
		}
	}
}

// historicalProcess вызывает только известные offline-команды подготовки.
// Ошибка эталона прерывает подготовку, до проверок Go не доходит.
func historicalProcess(t *testing.T, path string, args ...string) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "LC_ALL=C"}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err != nil {
		t.Fatalf("историческая фикстура %s: %v\n%s\n%s", path, err, data, stderr.String())
	}
	return data
}

// stateFixtureHashes снимает SHA-256 байтов каждого файла тестового дерева.
// Сравнение доказывает отсутствие побочных writes при чтении.
func stateFixtureHashes(t *testing.T, root string) map[string][32]byte {
	t.Helper()
	hashes := make(map[string][32]byte)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		hashes[path] = sha256.Sum256(data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return hashes
}
