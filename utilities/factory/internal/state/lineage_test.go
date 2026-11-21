package state

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestAttemptLineageCAS(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "tests", "fixtures",
		"analytics", "provider-lineage-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	vectors, err := decodeRecord(raw)
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := Store{ControlDir: root}
	for _, operation := range []string{"initialize", "reserve", "started", "advance"} {
		request := lineageFixtureRequest(t, vectors, operation)
		first, err := store.ChangeLineage(operation, request)
		if err != nil {
			t.Fatalf("%s: %v", operation, err)
		}
		retry, err := store.ChangeLineage(operation, request)
		if err != nil || !reflect.DeepEqual(first, retry) {
			t.Fatalf("идемпотентность %s: %v", operation, err)
		}
		if operation == "initialize" {
			value, err := lifecycleBytes(first, lineageBytesLimit)
			if err != nil || digestOf(value) != vectors["initialRecordSha256"] {
				t.Fatalf("не совпал golden initial record: %v", err)
			}
		}
		if operation == "started" {
			reserve := lineageFixtureRequest(t, vectors, "reserve")
			if _, err := store.ChangeLineage("reserve", reserve); !errors.Is(err, ErrLineageConsumed) {
				t.Fatalf("started predecessor допущен повторно: %v", err)
			}
		}
	}
	scope := objectField(vectors, "scopeTuple")
	lineage, err := store.ReadLineage(stringField(scope, "provider"), stringField(scope, "threadId"))
	if err != nil || lineage["state"] != "advanced" || integerField(lineage, "lineageGeneration") != 1 {
		t.Fatalf("неверное поколение проверенного successor: %v", err)
	}
}

// lineageFixtureRequest использует те же запросы, что исторический writer.
// Золотой SHA относится только к синтетической записи.
func lineageFixtureRequest(t *testing.T, vectors record, operation string) []byte {
	t.Helper()
	result, err := lifecycleBytes(objectField(vectors, operation+"Request"), lineageBytesLimit)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
