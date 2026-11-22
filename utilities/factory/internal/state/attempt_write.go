package state

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/route"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

type BindRuntime struct {
	Node, Helper, Reservation string
	Log                       io.Writer
}

type BeginInput struct {
	Task, Profile, RoutesDir, ExpectedCatalogHash string
	QueueDispatchID, RunnerPrimaryOverride        string
	Runtime                                       BindRuntime
	Previous, RecoveryReason                      string
}

// BeginAttempt публикует immutable attempt, затем bind и только после него active.
// Удерживаемый task flock исключает второй writer на всех трёх границах.
func (s Store) BeginAttempt(input BeginInput) (Attempt, int, error) {
	if err := input.validate(); err != nil {
		return Attempt{}, 78, err
	}
	owner, err := s.openTask(input.Task, true)
	if err != nil {
		return Attempt{}, 78, err
	}
	defer owner.close()

	if err := owner.createProtocol(); err != nil {
		return Attempt{}, 78, err
	}
	if _, err := owner.activeAttempt(input.Task); err == nil {
		return Attempt{}, 73, fmt.Errorf("%w: задача уже имеет активную попытку", ErrConflict)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Attempt{}, 78, err
	}
	if input.Previous != "" {
		previous, err := owner.readAttempt(input.Task, input.Previous)
		if err != nil {
			return Attempt{}, 78, err
		}
		if previous.Terminal != "abandoned" || previous.Profile != input.Profile ||
			previous.RoutesDir != input.RoutesDir {
			return Attempt{}, 75, fmt.Errorf("предшественница recovery должна быть закрыта abandon")
		}
		input.RunnerPrimaryOverride = previous.RunnerPrimaryOverride
	}
	catalog, rc, err := input.verifyCatalog()
	if err != nil {
		return Attempt{}, rc, err
	}
	attempt, err := owner.publishAttempt(input, catalog)
	if err != nil {
		return Attempt{}, 78, err
	}
	if err := owner.bind(input.Runtime, attempt); err != nil {
		var refusal bindError
		if errors.As(err, &refusal) {
			return attempt, refusal.code, err
		}
		return attempt, 78, err
	}
	if err := owner.publishActive(attempt); err != nil {
		if errors.Is(err, ErrConflict) {
			return attempt, 75, err
		}
		return attempt, 1, err
	}
	return attempt, 0, nil
}

// validate проверяет независимые параметры закрепления до открытия каталога control.
// Dispatch допускается только при exact expected catalog.
func (i BeginInput) validate() error {
	if !taskPattern.MatchString(i.Task) || !profilePattern.MatchString(i.Profile) ||
		!filepath.IsAbs(i.RoutesDir) || filepath.Clean(i.RoutesDir) != i.RoutesDir {
		return fmt.Errorf("attempt: неверные task, profile или routes-dir")
	}
	if i.ExpectedCatalogHash != "" && !digestPattern.MatchString(i.ExpectedCatalogHash) {
		return fmt.Errorf("attempt: неверный expected catalog hash")
	}
	if i.QueueDispatchID != "" &&
		(!dispatchPattern.MatchString(i.QueueDispatchID) || i.ExpectedCatalogHash == "") {
		return fmt.Errorf("attempt: dispatch требует точный catalog hash и UUID")
	}
	if i.RunnerPrimaryOverride != "" && !runnerPattern.MatchString(i.RunnerPrimaryOverride) {
		return fmt.Errorf("attempt: неверный runnerPrimaryOverride")
	}
	if i.Previous != "" && (!attemptPattern.MatchString(i.Previous) || !validReason(i.RecoveryReason) ||
		i.QueueDispatchID != "") {
		return fmt.Errorf("recovery: нужны прежняя попытка и причина без queue dispatch")
	}
	return nil
}

// verifyCatalog сверяет опубликованную ревизию под task lock.
// Отсутствующий current отличается от повреждённого каталога.
func (i BeginInput) verifyCatalog() (string, int, error) {
	reader, err := route.NewBundleReader(i.RoutesDir, i.Profile)
	if err != nil {
		return "", 78, err
	}
	catalog, err := reader.ReadCurrent()
	if err != nil {
		currentDir := filepath.Join(i.RoutesDir, i.Profile, "catalog")
		real, resolveErr := filepath.EvalSymlinks(currentDir)
		_, pointerErr := os.Lstat(filepath.Join(currentDir, "current.json"))
		if i.ExpectedCatalogHash != "" && resolveErr == nil && real == currentDir &&
			errors.Is(pointerErr, os.ErrNotExist) {
			return "", 75, catalogChanged(i.ExpectedCatalogHash, "none")
		}
		return "", 78, err
	}
	if i.ExpectedCatalogHash != "" && catalog.Hash != i.ExpectedCatalogHash {
		return "", 75, catalogChanged(i.ExpectedCatalogHash, catalog.Hash)
	}
	return catalog.Hash, 0, nil
}

func catalogChanged(expected, actual string) error {
	return fmt.Errorf("FACTORY_ERROR=catalog_changed EXPECTED=%s ACTUAL=%s", expected, actual)
}

// createProtocol проверяет существующую версию либо фиксирует её при первом запуске.
// Read-only путь использует отдельную requireProtocol.
func (t *taskState) createProtocol() error {
	if err := t.requireProtocol(); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return writeRecord(t.root, "protocol.json", record{"schema": 1, "protocolVersion": 2})
}

// publishAttempt создаёт неизменяемые документы в приватном соседнем каталоге.
// Bind получает только уже опубликованный final, прошедший проверки чтения.
func (t *taskState) publishAttempt(input BeginInput, catalog string) (Attempt, error) {
	if err := ensurePrivateDirectory(t.root, "attempts", true); err != nil {
		return Attempt{}, err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return Attempt{}, err
	}
	id := "a_" + hex.EncodeToString(random[:])
	attempt := Attempt{
		ID: id, Task: input.Task, Profile: input.Profile, RoutesDir: input.RoutesDir,
		CatalogHash: catalog, QueueDispatchID: input.QueueDispatchID,
		RunnerPrimaryOverride: input.RunnerPrimaryOverride,
	}
	temporary := filepath.Join("attempts", ".new-"+rand.Text())
	if err := t.root.Mkdir(temporary, 0700); err != nil {
		return Attempt{}, err
	}
	defer t.root.RemoveAll(temporary)
	staging, err := t.root.OpenRoot(temporary)
	if err != nil {
		return Attempt{}, err
	}
	defer staging.Close()
	if err := writeAttemptFiles(staging, attempt, input); err != nil {
		return Attempt{}, err
	}
	if input.Previous != "" {
		if err := t.inheritRecoveryInputs(staging, input.Previous); err != nil {
			return Attempt{}, err
		}
	}
	final := filepath.Join("attempts", id)
	if _, err := t.root.Lstat(final); !errors.Is(err, os.ErrNotExist) {
		return Attempt{}, fmt.Errorf("%w: путь новой попытки уже занят", ErrConflict)
	}
	if err := t.root.Rename(temporary, final); err != nil {
		return Attempt{}, err
	}
	if err := host.SyncDirectory(t.root, "attempts"); err != nil {
		return Attempt{}, err
	}
	return attempt, nil
}

// writeAttemptFiles фиксирует схему и checksums в историческом формате.
// Bootstrap и catalog закрепляются до любой маршрутизации.
func writeAttemptFiles(root *os.Root, attempt Attempt, input BeginInput) error {
	for _, name := range []string{"stage-results", "artifacts", "transactions"} {
		if err := ensurePrivateDirectory(root, name, true); err != nil {
			return err
		}
	}
	metadata := record{
		"schema": 2, "protocolVersion": 2, "attemptId": attempt.ID, "taskId": attempt.Task,
		"profile": attempt.Profile, "createdAt": time.Now().UTC().Format(time.RFC3339),
		"routesDir": attempt.RoutesDir, "catalogHash": attempt.CatalogHash, "origin": "fresh",
		"previousAttemptId": nil, "recoveryReason": nil, "queueDispatchId": nil,
		"runnerPrimaryOverride": attempt.RunnerPrimaryOverride,
	}
	if attempt.QueueDispatchID != "" {
		metadata["queueDispatchId"] = attempt.QueueDispatchID
	}
	if input.Previous != "" {
		metadata["origin"], metadata["previousAttemptId"] = "recovery", input.Previous
		metadata["recoveryReason"] = input.RecoveryReason
	}
	pins := record{
		"schema": 1, "protocolVersion": 2, "attemptId": attempt.ID, "taskId": attempt.Task,
		"profile": attempt.Profile, "catalogHash": attempt.CatalogHash,
		"bootstrap": record{"id": "scout", "catalogHash": attempt.CatalogHash},
	}
	if err := writeChecksummedRecord(root, "attempt", metadata); err != nil {
		return err
	}
	return writeChecksummedRecord(root, "pins", pins)
}

// inheritRecoveryInputs копирует immutable входы под lock в ещё не опубликованный каталог.
// Результаты bootstrap и stage не переходят в новую попытку.
func (t *taskState) inheritRecoveryInputs(staged *os.Root, previous string) error {
	fields := []string{"ticket.json", "delivery.tsv", "instrumentation-scope.tsv", "diagnosis.env",
		"profile-contract.tsv", "project-context.json"}
	for _, name := range fields {
		path := filepath.Join("attempts", previous, "artifacts", name)
		data, err := readTrusted(t.root, path, metadataBytes, immutableMode)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		destination := filepath.Join("artifacts", name)
		if err := publishFile(staged, destination, data, immutableMode, false); err != nil {
			return err
		}
	}
	return nil
}

type bindError struct {
	code int
}

func (e bindError) Error() string {
	return fmt.Sprintf("bind runtime: код %d", e.code)
}

// bind повторно открывает immutable attempt перед вызовом серверного helper.
// При отказе final остаётся доступен для диагностики и reservation остаётся у сервера.
func (t *taskState) bind(config BindRuntime, attempt Attempt) error {
	if config.Node == "" && config.Helper == "" && config.Reservation == "" {
		return nil
	}
	if _, err := t.readAttempt(attempt.Task, attempt.ID); err != nil {
		return err
	}
	final := filepath.Join(t.root.Name(), "attempts", attempt.ID)
	code := bindPublishedAttempt(config.Node, config.Helper, config.Reservation,
		attempt.Task, attempt.ID, final, config.Log)
	if code != 0 {
		return bindError{code}
	}
	return nil
}

// publishActive публикует только новую запись active-attempt, не заменяя старую.
// Мутацию делает тот же writer, который подтвердил immutable metadata.
func (t *taskState) publishActive(attempt Attempt) error {
	return writeRecord(t.root, "active-attempt.json", record{
		"schema": 1, "protocolVersion": 2, "taskId": attempt.Task, "attemptId": attempt.ID,
	})
}

// SelectRoute добавляет единственное неизменяемое закрепление внутри попытки.
// Повтор выбора того же маршрута идемпотентен под task lock.
func (s Store) SelectRoute(task, id, selected string) (Attempt, error) {
	if !attemptPattern.MatchString(id) || !stagePattern.MatchString(selected) || selected == "catalog" {
		return Attempt{}, fmt.Errorf("route-pin: неверная попытка или маршрут")
	}
	t, err := s.openTask(task, true)
	if err != nil {
		return Attempt{}, err
	}
	defer t.close()
	active, err := t.activeAttempt(task)
	if err != nil || active != id {
		return Attempt{}, fmt.Errorf("%w: нет exact active", ErrConflict)
	}
	attempt, err := t.readAttempt(task, id)
	if err != nil {
		return Attempt{}, err
	}
	if attempt.Terminal != "" || (attempt.RouteID != "" && attempt.RouteID != selected) {
		return Attempt{}, fmt.Errorf("%w: маршрут уже закреплён или попытка закрыта", ErrConflict)
	}
	if attempt.RouteID == selected {
		return attempt, nil
	}
	return t.publishRoute(attempt, selected)
}

// publishRoute пишет pin только после проверки существующей immutable ревизии.
// Хэш записи берётся из записываемого документа pin.
func (t *taskState) publishRoute(attempt Attempt, selected string) (Attempt, error) {
	reader, err := route.NewBundleReader(attempt.RoutesDir, attempt.Profile)
	if err != nil {
		return Attempt{}, err
	}
	catalog, err := reader.ReadCatalog(attempt.CatalogHash)
	if err != nil {
		return Attempt{}, err
	}
	hash, exists := catalog.Routes[selected]
	if !exists {
		return Attempt{}, fmt.Errorf("route-pin: маршрут %s отсутствует в каталоге", selected)
	}
	data, err := indentRecord(record{
		"schema": 1, "protocolVersion": 2, "taskId": attempt.Task, "attemptId": attempt.ID,
		"profile": attempt.Profile, "catalogHash": attempt.CatalogHash,
		"routeId": selected, "routeHash": hash, "selectedAt": time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		return Attempt{}, err
	}
	name := filepath.Join("attempts", attempt.ID, "route-pin."+digestOf(data)+".json")
	if err := publishFile(t.root, name, data, immutableMode, false); err != nil {
		return Attempt{}, err
	}
	attempt.RouteID, attempt.RouteHash = selected, hash
	return attempt, nil
}

// writeRecord сериализует обычный immutable metadata JSON с LF.
// Stage и lifecycle используют свои кодеки вместо этой формы.
func writeRecord(root *os.Root, name string, value record) error {
	data, err := indentRecord(value)
	if err != nil {
		return err
	}
	return publishFile(root, name, data, immutableMode, false)
}

// writeChecksummedRecord публикует документ и SHA над теми же байтами.
// Оба файла появляются в staging до публикации каталога попытки.
func writeChecksummedRecord(root *os.Root, name string, value record) error {
	data, err := indentRecord(value)
	if err != nil {
		return err
	}
	if err := publishFile(root, name+".json", data, immutableMode, false); err != nil {
		return err
	}
	return publishFile(root, name+".sha256", []byte(digestOf(data)+"\n"), immutableMode, false)
}

// indentRecord использует сортированные ключи и исторические отступы metadata.
// Числа не перестраиваются через float64.
func indentRecord(value record) ([]byte, error) {
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(value)
	return output.Bytes(), err
}
