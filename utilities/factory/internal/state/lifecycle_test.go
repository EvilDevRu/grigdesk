package state

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLifecycleCanonicalGolden(t *testing.T) {
	vectors := lifecycleVectors(t)
	preimage := stringField(vectors, "canonicalPreimage")
	value, err := parseLifecycleRecord([]byte(preimage), lifecycleLineLimit)
	if err != nil {
		t.Fatal(err)
	}
	output, err := lifecycleBytes(value, lifecycleLineLimit)
	if err != nil || string(output) != preimage || digestOf(output) != vectors["eventHash"] {
		t.Fatalf("канонический eventHash не совпал с golden: %v", err)
	}
	for _, invalid := range []string{
		`{"v":9007199254740992}`, `{"v":3.0}`, `{"v":"\ud800"}`, `{"v":1,"v":1}`,
	} {
		if _, err := parseLifecycleRecord([]byte(invalid), lifecycleLineLimit); err == nil {
			t.Fatalf("неверный lifecycle JSON принят: %s", invalid)
		}
	}
	if _, err := parseLifecycleRecord([]byte(`{"v":9007199254740991}`), lifecycleLineLimit); err != nil {
		t.Fatal(err)
	}
}

func TestLifecycleReadHistorical(t *testing.T) {
	fixture := seedHistoricalAttempt(t)
	lines := seedHistoricalLifecycle(t, fixture)
	before := stateFixtureHashes(t, fixture.store.ControlDir)
	events, err := fixture.store.ReadLifecycle("51", fixture.active)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || !bytes.Equal(append(events[0].Line, events[1].Line...), lines) {
		t.Fatalf("неверные байты %d записей lifecycle", len(events))
	}
	if after := stateFixtureHashes(t, fixture.store.ControlDir); !reflect.DeepEqual(before, after) {
		t.Fatal("чтение lifecycle изменило оригинальные файлы")
	}
}

func TestLifecycleRecoverTorn(t *testing.T) {
	fixture := seedHistoricalAttempt(t)
	seedHistoricalLifecycle(t, fixture)
	dir := filepath.Join(fixture.store.ControlDir, "protocol-v2", "tasks", "t51",
		"attempts", fixture.active, "lifecycle")
	manifestBytes, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := parseLifecycleRecord(manifestBytes, metadataBytes)
	if err != nil {
		t.Fatal(err)
	}
	active := filepath.Join(dir, "segments", stringField(manifest, "activeSegment"))
	torn := []byte(`{"torn":`)
	file, err := os.OpenFile(active, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(torn); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	bytesBefore, err := os.ReadFile(active)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.ReadLifecycle("51", fixture.active); !errors.Is(err, ErrLifecycleIncomplete) {
		t.Fatalf("оборванный хвост: %v", err)
	}
	if data, err := os.ReadFile(active); err != nil || !bytes.Equal(bytesBefore, data) {
		t.Fatalf("путь чтения изменил оригинальный хвост: %v", err)
	}
	draft := objectField(lifecycleVectors(t), "draft")
	draft["taskId"], draft["attemptId"], draft["profile"] = "t51", fixture.active, "demo-profile"
	draft["eventId"] = "ev_00000000000000000000000000000003"
	raw, err := lifecycleBytes(draft, lifecycleLineLimit)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := fixture.store.AppendLifecycle("51", fixture.active, raw, 1200)
	if err != nil {
		t.Fatal(err)
	}
	if hashFromRetry, err := fixture.store.AppendLifecycle("51", fixture.active, raw, 1200); err != nil ||
		hashFromRetry != hash {
		t.Fatalf("повтор append дал другой хэш: %v", err)
	}
	quarantine := filepath.Join(dir, "quarantine", digestOf(bytesBefore)+".ndjson")
	if data, err := os.ReadFile(quarantine); err != nil || !bytes.Equal(bytesBefore, data) {
		t.Fatalf("карантин не сохранил исходные байты: %v", err)
	}
	events, err := fixture.store.ReadLifecycle("51", fixture.active)
	if err != nil || len(events) != 4 || events[2].Data["kind"] != "lifecycle_tail_recovered" ||
		events[3].Hash != hash {
		t.Fatalf("неверная достроенная цепочка: записей=%d err=%v", len(events), err)
	}
	draft["writerVersion"] = "fixture-2"
	different, err := lifecycleBytes(draft, lifecycleLineLimit)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.store.AppendLifecycle("51", fixture.active, different, 1200)
	if !errors.Is(err, ErrLifecycleEventID) {
		t.Fatalf("другой payload того же eventId принят: %v", err)
	}
}

// lifecycleVectors читает общие тестовые векторы старого writer и Node.
// Вход содержит только синтетические идентификаторы и метаданные.
func lifecycleVectors(t *testing.T) record {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "tests", "fixtures",
		"analytics", "lifecycle-event-vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	vectors, err := decodeRecord(data)
	if err != nil {
		t.Fatal(err)
	}
	return vectors
}

// seedHistoricalLifecycle использует исходные события и независимый указатель старого writer.
// Смена сегмента и точные raw bytes остаются частью проверки.
func seedHistoricalLifecycle(t *testing.T, fixture historicalFixture) []byte {
	t.Helper()
	attempt := filepath.Join(fixture.store.ControlDir, "protocol-v2", "tasks", "t51",
		"attempts", fixture.active)
	dir := filepath.Join(attempt, "lifecycle")
	installHistoricalFiles(t, "lifecycle.json", dir, fixture.routes)
	for _, empty := range []string{"quarantine", "usage"} {
		if err := os.Mkdir(filepath.Join(dir, empty), 0700); err != nil {
			t.Fatal(err)
		}
	}
	return historicalInput(t, "lifecycle.ndjson")
}
