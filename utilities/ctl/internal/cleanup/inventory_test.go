package cleanup

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"grigdesk.local/tools/utilities/ctl/internal/service"
)

// inventoryFixture создаёт свежие каталоги с предсказуемым порядком занятых блоков.
// За корнем есть файл для проверки, что инвентаризация не обходит цель ссылки.
func inventoryFixture(t *testing.T) string {
	t.Helper()
	outside := t.TempDir()
	root := filepath.Join(outside, "artifacts")
	chat := filepath.Join(root, "chat-runs")
	factory := filepath.Join(root, "factory-go", "acceptance")
	mirror := filepath.Join(root, "z-mirror")
	for _, directory := range []string{chat, factory, mirror} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(factory, "build")
	for name, size := range map[string]int{
		file: 2 << 20, filepath.Join(chat, "screenshot"): 1 << 17, filepath.Join(outside, "outside"): 4 << 20,
	} {
		if err := os.WriteFile(name, make([]byte, size), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Link(file, filepath.Join(mirror, "build")); err != nil {
		t.Fatal(err)
	}
	sparse, err := os.Create(filepath.Join(mirror, "sparse"))
	if err != nil {
		t.Fatal(err)
	}
	truncateErr := sparse.Truncate(32 << 20)
	closeErr := sparse.Close()
	if truncateErr != nil || closeErr != nil {
		t.Fatalf("разреженный файл: truncate=%v, close=%v", truncateErr, closeErr)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	return root
}

// runInventoryFixture проходит через публичный вход уборки с опасным по умолчанию режимом.
// Любое попадание в ветку подтверждения делает тест красным.
func runInventoryFixture(t *testing.T, ctx context.Context, root string,
	args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	terminal := service.Terminal{Stdin: bytes.NewReader(nil), Stdout: &stdout, Stderr: &stderr}
	env := map[string]string{"GRIGDESK_ARTIFACTS_DIR": root, "LANG": "en"}
	code := Run(ctx, env, args, terminal, func(Report) (bool, error) {
		t.Fatal("инвентаризация предложила удаление")
		return false, nil
	})
	return code, stdout.String(), stderr.String()
}

// TestInventoryByAllocatedSize проверяет разрезы отчёта и повторный просмотр темы.
// Дополнительно проверяет, что жёсткие и символические ссылки не раздувают итог.
func TestInventoryByAllocatedSize(t *testing.T) {
	ctx := t.Context()
	root := inventoryFixture(t)
	code, stdout, stderr := runInventoryFixture(t, ctx, root, "--inventory", "--json")
	if code != 0 || stderr != "" {
		t.Fatalf("код %d, stderr: %s", code, stderr)
	}
	var report inventoryReport
	if err := json.Unmarshal([]byte(stdout), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Entries) != 4 || len(report.Groups) != 3 {
		t.Fatalf("неожиданные строки: %+v", report)
	}
	factory, chat := report.Entries[0], report.Entries[1]
	if factory.Path != "factory-go" || factory.Kind != "factory-checks" ||
		chat.Path != "chat-runs" || chat.Kind != "chat-runs" {
		t.Fatalf("неожиданные категории: %+v", report.Entries)
	}
	if report.TotalBytes < 2<<20 || report.TotalBytes >= 3<<20 || report.Groups[0].Bytes != factory.Bytes {
		t.Fatalf("неожиданные размеры: %+v", report)
	}

	code, stdout, stderr = runInventoryFixture(t, ctx, root, "--inventory", "--topic", "factory-go", "--json")
	var scoped inventoryReport
	if err := json.Unmarshal([]byte(stdout), &scoped); code != 0 || err != nil || len(scoped.Entries) != 1 {
		t.Fatalf("отчёт темы: код %d, %s, %s", code, stdout, stderr)
	}
	if row := scoped.Entries[0]; scoped.Topic != "factory-go" || row.Path != "acceptance" ||
		row.Kind != factory.Kind || row.Bytes < 2<<20 {
		t.Fatalf("неожиданная запись темы: %+v", scoped)
	}
	if _, err := os.Stat(filepath.Join(root, "factory-go", "acceptance", "build")); err != nil {
		t.Fatal(err)
	}
}

// TestInventoryInvalidScopeAndCancellation защищает границу выбора папки и частичный JSON.
// Отдельно запрещает сочетания флагов, которые могли бы выглядеть как команда удаления.
func TestInventoryInvalidScopeAndCancellation(t *testing.T) {
	root := inventoryFixture(t)
	for _, args := range [][]string{
		{"--inventory", "--topic", "../"}, {"--topic", "factory-go"}, {"--inventory", "--older-than", "1m"},
	} {
		code, _, _ := runInventoryFixture(t, t.Context(), root, args...)
		if code != 2 {
			t.Fatalf("аргументы %v: код %d вместо 2", args, code)
		}
	}
	code, _, _ := runInventoryFixture(t, t.Context(), root, "--inventory", "--topic", "link")
	if code != 1 {
		t.Fatalf("выбор ссылки: код %d вместо 1", code)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	code, stdout, _ := runInventoryFixture(t, ctx, root, "--inventory", "--json")
	decoder := json.NewDecoder(bytes.NewBufferString(stdout))
	var report inventoryReport
	if err := decoder.Decode(&report); code != 130 || err != nil || !report.Interrupted {
		t.Fatalf("отмена: код %d, %s", code, stdout)
	}
	if err := decoder.Decode(&report); err != io.EOF {
		t.Fatalf("после отмены ожидался один JSON-документ, получено %v", err)
	}
}
