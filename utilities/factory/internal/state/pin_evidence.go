package state

import (
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

// RoutePinEvidence возвращает digest оригинальных bytes route-pin.
// Пин и родительская identity перепроверяются под одним task lock.
func (s Store) RoutePinEvidence(task, id string) (string, string, error) {
	if !attemptPattern.MatchString(id) {
		return "", "", fmt.Errorf("route pin: нужна точная попытка")
	}
	t, err := s.openTask(task, false)
	if err != nil {
		return "", "", err
	}
	defer t.close()
	a, err := t.readAttempt(task, id)
	if err != nil || a.RouteID == "" {
		return "", "", fmt.Errorf("route pin: попытка не закреплена")
	}
	dir, err := t.root.OpenRoot(filepath.Join("attempts", id))
	if err != nil {
		return "", "", err
	}
	defer dir.Close()
	entries, err := fs.ReadDir(dir.FS(), ".")
	if err != nil {
		return "", "", err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "route-pin.") || !strings.HasSuffix(name, ".json") {
			continue
		}
		raw, err := readTrusted(dir, name, metadataBytes, immutableMode)
		if err != nil || name != "route-pin."+digestOf(raw)+".json" {
			return "", "", fmt.Errorf("route pin: оригинальные bytes повреждены")
		}
		value, err := decodeRecord(raw)
		if err != nil || !identityMatches(value, task, id) || value["routeHash"] != a.RouteHash {
			return "", "", fmt.Errorf("route pin: изменилась identity")
		}
		return digestOf(raw), stringField(value, "selectedAt"), nil
	}
	return "", "", fmt.Errorf("route pin: документ отсутствует")
}
