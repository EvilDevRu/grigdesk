package state

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

type InstrumentationJournal struct {
	root   *os.Root
	lock   *os.File
	prefix string
}

type InstrumentationStatus struct {
	Phase, Isolation, Reason string
	Checkpoint               int64
}

const instrumentationBytes = 64 * 1024 * 1024

// LockInstrumentation использует прежний Linux lock транзакции.
// Все публикации происходят внутри уже проверенного приватного control root.
func (s Store) LockInstrumentation(a Attempt, create bool) (*InstrumentationJournal, error) {
	if !attemptPattern.MatchString(a.ID) || !taskPattern.MatchString(a.Task) {
		return nil, fmt.Errorf("instrumentation: требуется точная попытка")
	}
	root, err := openControl(s.ControlDir, false)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir := filepath.Join("transactions", "t"+a.Task)
	for _, name := range []string{"transactions", dir} {
		if !create {
			if _, err := root.Lstat(name); err != nil {
				return nil, err
			}
		}
		if err := ensurePrivateDirectory(root, name, true); err != nil {
			return nil, err
		}
	}
	subdir, err := root.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	lock, err := openNamedLock(subdir, ".lock")
	if err != nil {
		subdir.Close()
		return nil, err
	}
	if err := flock(lock, lockExclusive); err != nil {
		lock.Close()
		subdir.Close()
		return nil, err
	}
	return &InstrumentationJournal{root: subdir, lock: lock, prefix: "v2-" + a.ID[2:] + "-s"}, nil
}

func (j *InstrumentationJournal) Close() {
	j.lock.Close()
	j.root.Close()
}

// Active читает указатель в прежнем env-формате и сверяет identity попытки.
// Пустой указатель отличается от повреждённого или чужого.
func (j *InstrumentationJournal) Active() (string, error) {
	raw, err := readTrusted(j.root, "active.env", 4096, ownerMode)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	id := strings.TrimSuffix(strings.TrimPrefix(string(raw), "SCHEMA=1\nTRANSACTION_ID="), "\n")
	if !j.validID(id) || string(raw) != instrumentationPointer(id) {
		return "", fmt.Errorf("%w: чужой или повреждённый указатель инструментации", ErrConflict)
	}
	return id, nil
}

func instrumentationPointer(id string) string {
	return "SCHEMA=1\nTRANSACTION_ID=" + id + "\n"
}

func (j *InstrumentationJournal) validID(id string) bool {
	sequence, found := strings.CutPrefix(id, j.prefix)
	n, err := strconv.ParseInt(sequence, 10, 64)
	return found && len(sequence) <= 18 && err == nil && n >= 0 && strconv.FormatInt(n, 10) == sequence
}

// Next проверяет прежние каталоги exact attempt до выбора свободного номера.
// Каталог с незакрытой транзакцией нельзя обойти после обрыва публикации указателя.
func (j *InstrumentationJournal) Next(sequence int64) (string, error) {
	file, err := j.root.Open(".")
	if err != nil {
		return "", err
	}
	names, err := file.Readdirnames(-1)
	file.Close()
	if err != nil {
		return "", err
	}
	used := make(map[string]bool)
	for _, id := range names {
		if !strings.HasPrefix(id, j.prefix) {
			continue
		}
		status, err := j.Status(id)
		if err != nil || status.Phase != "completed" {
			return "", fmt.Errorf("%w: незавершённый каталог инструментации %s", ErrConflict, id)
		}
		used[id] = true
	}
	for {
		id := j.prefix + strconv.FormatInt(sequence, 10)
		if !j.validID(id) {
			return "", fmt.Errorf("instrumentation: исчерпан диапазон sequence")
		}
		if !used[id] {
			return id, nil
		}
		sequence++
	}
}

// Begin фиксирует baseline и резервные копии перед разрешением на запуск.
// Указатель виден только после durable публикации целого каталога.
func (j *InstrumentationJournal) Begin(
	id string, files map[string][]byte, status InstrumentationStatus,
) error {
	if !j.validID(id) {
		return fmt.Errorf("instrumentation: повреждённый id")
	}
	active, err := j.Active()
	if err != nil || active != "" {
		return fmt.Errorf("%w: уже есть указатель инструментации", ErrConflict)
	}
	if _, err := j.root.Lstat(id); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%w: каталог инструментации уже занят", ErrConflict)
	}
	tmp := ".tx-" + rand.Text()
	if err := j.root.Mkdir(tmp, 0700); err != nil {
		return err
	}
	defer j.root.RemoveAll(tmp)
	dest, err := j.root.OpenRoot(tmp)
	if err != nil {
		return err
	}
	defer dest.Close()
	for _, dir := range []string{"backups", "indexes"} {
		if err := dest.Mkdir(dir, 0700); err != nil {
			return err
		}
	}
	for name, raw := range files {
		mode := ownerMode
		if name == "isolation" {
			mode = immutableMode
		}
		if err := publishFile(dest, name, raw, mode, false); err != nil {
			return err
		}
	}
	if err := publishFile(dest, "state.env", instrumentationStateBytes(status), ownerMode, false); err != nil {
		return err
	}
	if err := j.root.Rename(tmp, id); err != nil {
		return err
	}
	if err := host.SyncDirectory(j.root, "."); err != nil {
		return err
	}
	return publishFile(j.root, "active.env", []byte(instrumentationPointer(id)), ownerMode, false)
}

// Status декодирует прежнее состояние Linux и проверяет целый набор полей.
// Старые Darwin receipts требуют своего нативного протокола.
func (j *InstrumentationJournal) Status(id string) (InstrumentationStatus, error) {
	raw, err := j.Read(id, "state.env")
	if err != nil {
		return InstrumentationStatus{}, err
	}
	fields, err := parseRunFields(raw)
	checkpoint, parseErr := strconv.ParseInt(fields["CHECKPOINT"], 10, 64)
	status := InstrumentationStatus{Phase: fields["STATE"], Isolation: fields["ISOLATION"],
		Reason: fields["REASON"], Checkpoint: checkpoint}
	switch status.Phase {
	case "active", "cleaning", "completed", "stalled":
	default:
		return status, fmt.Errorf("instrumentation: неверная стадия транзакции")
	}
	if err != nil || parseErr != nil || checkpoint < 0 || fields["SCHEMA"] != "1" ||
		(status.Isolation != "exclusive-worktree-v1" && status.Isolation != "exclusive-shared-checkout-v1") ||
		string(raw) != string(instrumentationStateBytes(status)) {
		return status, fmt.Errorf("instrumentation: неверный state.env")
	}
	return status, nil
}

// instrumentationStateBytes сохраняет точный порядок Linux-реестра.
// Прежний reader видит стадии отказа и завершения в том же формате.
func instrumentationStateBytes(s InstrumentationStatus) []byte {
	raw := fmt.Appendf(nil, "SCHEMA=1\nISOLATION=%s\nSTATE=%s\nCHECKPOINT=%d\n",
		s.Isolation, s.Phase, s.Checkpoint)
	if s.Reason != "" {
		raw = fmt.Appendf(raw, "REASON=%s\n", s.Reason)
	}
	return raw
}

func (j *InstrumentationJournal) SetStatus(id string, status InstrumentationStatus) error {
	return j.Write(id, "state.env", instrumentationStateBytes(status), true)
}

// Read проверяет каталог транзакции и обычный файл с одним именем.
// Метаданные Linux-поколения могли получить общий режим от umask хоста.
func (j *InstrumentationJournal) Read(id, name string) ([]byte, error) {
	dir, err := j.open(id)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	return readTrusted(dir, name, instrumentationBytes, legacyProjection)
}

// Write публикует очередную запись в уже созданной транзакции.
// Проверяется принадлежность каталога, изменение узла остаётся за оркестратором.
func (j *InstrumentationJournal) Write(id, name string, raw []byte, replace bool) error {
	dir, err := j.open(id)
	if err != nil {
		return err
	}
	defer dir.Close()
	return publishFile(dir, name, raw, ownerMode, replace)
}

func (j *InstrumentationJournal) open(id string) (*os.Root, error) {
	if !j.validID(id) {
		return nil, fmt.Errorf("instrumentation: повреждённый id")
	}
	if err := ensurePrivateDirectory(j.root, id, false); err != nil {
		return nil, err
	}
	return j.root.OpenRoot(id)
}

// Clear завершает только точный активный указатель и синхронизирует каталог.
// Сами свидетельства остаются доступны после очистки.
func (j *InstrumentationJournal) Clear(id string) error {
	active, err := j.Active()
	if err != nil || active != id {
		return fmt.Errorf("%w: указатель инструментации изменился", ErrConflict)
	}
	if err := j.root.Remove("active.env"); err != nil {
		return err
	}
	return host.SyncDirectory(j.root, ".")
}
