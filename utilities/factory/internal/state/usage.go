package state

import (
	"bytes"
	_ "embed"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
)

//go:embed schema/usage-document.schema.json
var usageSchema []byte

var loadUsageContract = sync.OnceValues(func() (lifecycleContract, error) {
	return parseLifecycleContract(usageSchema)
})

type UsageCitation struct {
	DocumentHash, RunID, CheckpointHash string
	Provider, Dialect, Scope            string
}

// ReadParentUsage подтверждает полную метрику predecessor и её checkpoint.
// Ссылка на произвольный provider-writable output не считается доказательством.
func (s Store) ReadParentUsage(task, id, filename string, cite UsageCitation) (map[string]any, error) {
	if filename == "" || filename == "." || filepath.Base(filename) != filename ||
		!digestPattern.MatchString(cite.DocumentHash) || !digestPattern.MatchString(cite.CheckpointHash) ||
		cite.RunID == "" || cite.Provider == "" || cite.Dialect == "" || cite.Scope == "" ||
		len(cite.Scope) > 512 || strings.ContainsAny(cite.Scope, "\x00\r\n") {
		return nil, fmt.Errorf("usage: неверная ссылка predecessor")
	}
	dir, err := s.openLifecycle(task, id, false, false)
	if err != nil {
		return nil, err
	}
	defer dir.close()
	if err := ensurePrivateDirectory(dir.root, "usage", false); err != nil {
		return nil, err
	}
	raw, err := readTrusted(dir.root, filepath.Join("usage", filename), metadataBytes, ownerMode)
	if err != nil {
		return nil, err
	}
	if digestOf(raw) != cite.DocumentHash {
		return nil, fmt.Errorf("usage: SHA predecessor не совпадает")
	}
	return checkedUsage(raw, cite)
}

// checkedUsage проверяет метаданные и точный reusable checkpoint.
// Неполные документы доступны диагностике, но не этому пути возобновления.
func checkedUsage(raw []byte, cite UsageCitation) (record, error) {
	value, err := decodeRecord(raw)
	if err != nil {
		return nil, err
	}
	encoded, err := compactRecord(value)
	if err != nil || !bytes.Equal(raw, encoded) {
		return nil, fmt.Errorf("usage: документ не является каноническим JSON")
	}
	schema, err := loadUsageContract()
	if err != nil || !schema.matches(value, schema.schema) {
		return nil, fmt.Errorf("usage: документ не соответствует схеме")
	}
	checkpoint := objectField(value, "terminalCounterCheckpoint")
	if value["runId"] != cite.RunID || value["provider"] != cite.Provider ||
		value["normalizerDialect"] != cite.Dialect || value["observedProviderScope"] != cite.Scope ||
		value["completeness"] != "complete" || value["resumeEligible"] != true ||
		checkpoint["checkpointHash"] != cite.CheckpointHash || checkpoint["counterScope"] != cite.Scope ||
		checkpoint["resumeEligible"] != true {
		return nil, fmt.Errorf("usage: checkpoint predecessor не соответствует закреплению")
	}
	return checkpoint, nil
}

// PublishUsage фиксирует документы только в каталоге lifecycle этой попытки.
// Производственная обвязка передаёт уже нормализованный результат удержанного FD.
func (s Store) PublishUsage(task, id, filename string, raw []byte) error {
	if filename == "" || filename == "." || filepath.Base(filename) != filename || len(raw) > metadataBytes {
		return fmt.Errorf("usage: неверное имя или размер")
	}
	value, err := decodeRecord(raw)
	if err != nil {
		return err
	}
	schema, err := loadUsageContract()
	if err != nil || !schema.matches(value, schema.schema) {
		return fmt.Errorf("usage: документ не соответствует схеме")
	}
	dir, err := s.openLifecycle(task, id, true, false)
	if err != nil {
		return err
	}
	defer dir.close()
	if err := ensurePrivateDirectory(dir.root, "usage", false); err != nil {
		return err
	}
	if value["taskId"] != "t"+task || value["attemptId"] != id {
		return fmt.Errorf("usage: документ принадлежит другой попытке")
	}
	encoded, err := compactRecord(value)
	if err != nil || !bytes.Equal(raw, encoded) {
		return fmt.Errorf("usage: документ не является каноническим JSON")
	}
	return publishLifecycleBytes(dir.root, filepath.Join("usage", filename), raw, ownerMode)
}
