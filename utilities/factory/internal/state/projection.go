package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

var registryFieldPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

type ProjectionField struct {
	Key, Value string
}

type projectionWriter struct {
	root *os.Root
	lock *os.File
	name string
}

// UpdateProjection записывает удобную для чтения витрину под прежним pipeline lock.
// Основные поля закрепляются по trusted attempt, а не прочитанной витрине.
func (s Store) UpdateProjection(task, id string, fields []ProjectionField) error {
	if !attemptPattern.MatchString(id) {
		return fmt.Errorf("projection: нужна точная попытка")
	}
	for _, field := range fields {
		if !registryFieldPattern.MatchString(field.Key) || strings.ContainsRune(field.Value, 0) {
			return fmt.Errorf("projection: неверное поле registry")
		}
	}
	t, err := s.openTask(task, false)
	if err != nil {
		return err
	}
	defer t.close()
	attempt, err := t.readAttempt(task, id)
	if err != nil {
		return err
	}
	active, pointerErr := t.activeAttempt(task)
	if (pointerErr == nil && active != id) ||
		(pointerErr != nil && !(attempt.Terminal != "" && errors.Is(pointerErr, os.ErrNotExist))) {
		return fmt.Errorf("%w: проекция больше не принадлежит попытке", ErrConflict)
	}
	fields = append(append([]ProjectionField(nil), fields...),
		ProjectionField{"RUN_PROTOCOL", "2"}, ProjectionField{"CATALOG_PROTOCOL", "route-v2"},
		ProjectionField{"ATTEMPT_ID", id},
		ProjectionField{"PROFILE", attempt.Profile}, ProjectionField{"ROUTE", attempt.RouteID},
	)
	return s.writeProjection(task, fields)
}

// writeProjection сохраняет порядок живых полей файла и правила archive lookup.
// Состояние файла используется только для сохранения прочих полей, не для CAS попытки.
func (s Store) writeProjection(task string, fields []ProjectionField) error {
	writer, err := s.lockProjection(task)
	if err != nil {
		return err
	}
	defer writer.close()
	return writer.write(fields)
}

// lockProjection занимает тот же lock, что Bash writers статуса.
// Его удерживают до публикации control record и производной проекции.
func (s Store) lockProjection(task string) (*projectionWriter, error) {
	root, err := openControl(s.StateDir, false)
	if err != nil {
		return nil, err
	}
	name := "t" + task + ".pipeline"
	flags := os.O_RDWR | os.O_CREATE
	lock, err := host.OpenAt(root, name+".lock", flags, 0600, host.Nonblocking)
	if err != nil {
		root.Close()
		return nil, err
	}
	writer := &projectionWriter{root: root, lock: lock, name: name}
	info, err := lock.Stat()
	if err != nil || !info.Mode().IsRegular() || !host.FileOwner(lock, info) {
		writer.close()
		return nil, fmt.Errorf("projection: недопустимая блокировка")
	}
	if err := flock(lock, lockExclusive); err != nil {
		writer.close()
		return nil, err
	}
	return writer, nil
}

func (w *projectionWriter) close() {
	w.lock.Close()
	w.root.Close()
}

func (w *projectionWriter) write(fields []ProjectionField) error {
	selected, raw, err := findProjection(w.root, w.name)
	if err != nil {
		return err
	}
	var rows []string
	if len(raw) > 0 {
		rows = strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	}
	for _, field := range fields {
		rows = upsertProjection(rows, field)
	}
	return publishFile(w.root, selected, []byte(strings.Join(rows, "\n")+"\n"), ownerMode, true)
}

// findProjection читает активный файл, затем его прежнее архивное положение.
// Архив без текущего разрешённого attempt не используется для реконструкции маршрута.
func findProjection(root *os.Root, name string) (string, []byte, error) {
	data, err := readTrusted(root, name, metadataBytes, legacyProjection)
	if !errors.Is(err, os.ErrNotExist) {
		return name, data, err
	}
	archive := filepath.Join("archive", name)
	if info, err := root.Lstat("archive"); err == nil && !info.IsDir() {
		return "", nil, fmt.Errorf("projection: archive должен быть обычным каталогом")
	}
	data, err = readTrusted(root, archive, metadataBytes, legacyProjection)
	if errors.Is(err, os.ErrNotExist) {
		return name, nil, nil
	}
	return archive, data, err
}

// upsertProjection заменяет первое совпадение и убирает его дубликаты.
// Сторонние поля и порядок их строк остаются в прежнем состоянии.
func upsertProjection(rows []string, field ProjectionField) []string {
	value := field.Key + "=" + strings.ReplaceAll(field.Value, "\n", " ")
	result := make([]string, 0, len(rows)+1)
	replaced := false
	for _, row := range rows {
		name, _, _ := strings.Cut(row, "=")
		if name != field.Key {
			result = append(result, row)
		} else if !replaced {
			result = append(result, value)
			replaced = true
		}
	}
	if !replaced {
		result = append(result, value)
	}
	return result
}
