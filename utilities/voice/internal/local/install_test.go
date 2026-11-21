package local

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func digest(data []byte) string {
	value := sha256.Sum256(data)
	return hex.EncodeToString(value[:])
}

// modelFixture создаёт архив с настоящими двумя файлами и тестовыми пинами.
// Установщик проверит хеши и типы тем же кодом, который выполняется для рабочего пакета.
func modelFixture(t *testing.T) (Package, []byte) {
	t.Helper()
	packages, err := Packages()
	if err != nil {
		t.Fatal(err)
	}
	pack := packages[0]
	model := bytes.Repeat([]byte("фикстура модели"), 1024)
	config := []byte("{}")
	var archive bytes.Buffer
	compressed := gzip.NewWriter(&archive)
	writer := tar.NewWriter(compressed)
	for _, item := range []struct {
		name string
		data []byte
	}{{pack.ModelName, model}, {pack.ConfigName, config}} {
		if err := writer.WriteHeader(&tar.Header{
			Name: "./" + item.name,
			Mode: 0o600,
			Size: int64(len(item.data)),
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(item.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	pack.ArchiveSHA256 = digest(archive.Bytes())
	pack.ArchiveBytes = int64(archive.Len())
	pack.ModelSHA256 = digest(model)
	pack.ConfigSHA256 = digest(config)
	return pack, archive.Bytes()
}

// TestInstallRange проверяет реальный обрыв, восстановление, staging WAV и повтор со старым venv.
// Только bootstrap venv подменяется записью тестового исполняемого Python.
func TestInstallRange(t *testing.T) {
	pack, archive := modelFixture(t)
	prefix := len(archive) / 2
	var requestsMu sync.Mutex
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requestRange := req.Header.Get("Range")
		requestsMu.Lock()
		requests = append(requests, requestRange)
		index := len(requests)
		requestsMu.Unlock()
		if index == 1 {
			w.Header().Set("Content-Length", fmt.Sprint(len(archive)))
			_, _ = w.Write(archive[:prefix])
			w.(http.Flusher).Flush()
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", prefix, len(archive)-1, len(archive)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(archive[prefix:])
	}))
	defer server.Close()
	pack.URL = server.URL
	root := t.TempDir()
	bootstrap := 0
	spec := InstallSpec{
		Package:         pack,
		Directory:       root,
		BootstrapPython: "python-fixture",
		CommandTimeout:  5 * time.Second,
		Run: func(
			ctx context.Context, program string, args []string, input string, duration time.Duration,
		) ([]byte, error) {
			if program == "python-fixture" {
				bootstrap++
				return nil, prepareFixturePython(args[len(args)-1])
			}
			return Run(ctx, program, args, input, duration)
		},
	}
	if _, err := Install(t.Context(), spec); err == nil || !strings.Contains(err.Error(), "префикс") {
		t.Fatalf("ожидался обрыв, получено %v", err)
	}
	paths := selectedLayout(pack, root)
	data, err := os.ReadFile(paths.cache)
	if err != nil || !bytes.Equal(data, archive[:prefix]) || bootstrap != 0 {
		t.Fatalf("кэш %d байт, bootstrap %d, ошибка %v", len(data), bootstrap, err)
	}
	result, err := Install(t.Context(), spec)
	if err != nil || result.Package != pack.ID || result.Engine != "piper" || bootstrap != 1 {
		t.Fatalf("получено %+v, bootstrap %d, %v", result, bootstrap, err)
	}
	if _, err := os.Stat(result.Manifest); err != nil {
		t.Fatal(err)
	}
	target, err := os.Readlink(paths.current)
	if err != nil || !strings.HasPrefix(target, "runtimes/") {
		t.Fatalf("ссылка venv %q, %v", target, err)
	}
	if _, err := Install(t.Context(), spec); err != nil || bootstrap != 1 {
		t.Fatalf("повтор bootstrap %d, %v", bootstrap, err)
	}
	requestsMu.Lock()
	defer requestsMu.Unlock()
	if want := []string{"", fmt.Sprintf("bytes=%d-", prefix)}; !reflect.DeepEqual(requests, want) {
		t.Fatalf("запросы %v, ожидали %v", requests, want)
	}
}

// prepareFixturePython создаёт executable для тестового venv без настоящего pip.
// Контрольная реплика затем проходит через реальный процесс, argv и WAV.
func prepareFixturePython(runtime string) error {
	name := filepath.Join(runtime, "bin", "python")
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		return err
	}
	data, err := os.ReadFile("../../testdata/python-fixture.py")
	if err != nil {
		return err
	}
	return os.WriteFile(name, data, 0o700)
}

// TestInstallForeignLockAndMismatch сохраняет незнакомого владельца и отклоняет чужой digest.
// Ни один отказ не создаёт каталог живого движка или публичный manifest.
func TestInstallForeignLockAndMismatch(t *testing.T) {
	pack, archive := modelFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()
	pack.URL = server.URL
	pack.ArchiveSHA256 = strings.Repeat("1", 64)
	root := t.TempDir()
	spec := InstallSpec{Package: pack, Directory: root}
	lock := filepath.Join(root, "cache", "install.lock")
	if err := os.MkdirAll(lock, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(lock, "owner.json")
	foreign := []byte("{\"unknown\":true}\n")
	if err := os.WriteFile(file, foreign, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(t.Context(), spec); err == nil || !strings.Contains(err.Error(), "уже идёт") {
		t.Fatalf("отказ lock: %v", err)
	}
	if data, err := os.ReadFile(file); err != nil || !bytes.Equal(data, foreign) {
		t.Fatalf("чужой lock изменился: %q %v", data, err)
	}
	if err := os.RemoveAll(lock); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(t.Context(), spec); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("отказ по SHA: %v", err)
	}
	if _, err := os.Stat(pack.EngineRoot(root)); !os.IsNotExist(err) {
		t.Fatalf("неожиданный каталог движка: %v", err)
	}
}
