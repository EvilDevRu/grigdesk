package state

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"grigdesk.local/tools/utilities/factory/internal/route"
)

var (
	taskPattern     = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
	attemptPattern  = regexp.MustCompile(`^a_[a-f0-9]{32}$`)
	digestPattern   = regexp.MustCompile(`^[a-f0-9]{64}$`)
	profilePattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	stagePattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,40}$`)
	runnerPattern   = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
	dispatchPattern = regexp.MustCompile(
		`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

const metadataBytes = 2 * 1024 * 1024

type record = map[string]any

type Store struct {
	ControlDir string
	StateDir   string
}

type Attempt struct {
	ID, Task, Profile, RoutesDir, CatalogHash string
	QueueDispatchID, RunnerPrimaryOverride    string
	RouteID, RouteHash, Terminal              string
}

// ReadAttempt открывает метаданные только по точной identity.
// Проекция state не участвует в проверке, а терминал читается из закрытого журнала.
func (s Store) ReadAttempt(task, expected string) (Attempt, error) {
	if !attemptPattern.MatchString(expected) {
		return Attempt{}, fmt.Errorf("нужна точная попытка a_<32hex>")
	}
	owner, err := s.openTask(task, false)
	if err != nil {
		return Attempt{}, err
	}
	defer owner.close()
	attempt, err := owner.readAttempt(task, expected)
	if err != nil {
		return Attempt{}, err
	}
	if attempt.Terminal == "" {
		active, err := owner.activeAttempt(task)
		if err != nil {
			return Attempt{}, err
		}
		if active != expected {
			return Attempt{}, fmt.Errorf("%w: попытка больше не активна", ErrConflict)
		}
	}
	return attempt, nil
}

// readAttempt проверяет immutable identity, pins и объект записи выбранного маршрута.
// Закреплённый каталог проверяется повторно напрямую по SHA, без current.
func (t *taskState) readAttempt(task, id string) (Attempt, error) {
	if err := t.requireProtocol(); err != nil {
		return Attempt{}, err
	}
	if err := ensurePrivateDirectory(t.root, "attempts", false); err != nil {
		return Attempt{}, err
	}
	path := filepath.Join("attempts", id)
	if err := ensurePrivateDirectory(t.root, path, false); err != nil {
		return Attempt{}, err
	}
	root, err := t.root.OpenRoot(path)
	if err != nil {
		return Attempt{}, err
	}
	defer root.Close()

	value, err := readChecksummedRecord(root, "attempt")
	if err != nil {
		return Attempt{}, err
	}
	attempt, err := decodeAttempt(value, task, id)
	if err != nil {
		return Attempt{}, err
	}
	pins, err := readChecksummedRecord(root, "pins")
	if err != nil {
		return Attempt{}, err
	}
	if err := attempt.checkPins(pins); err != nil {
		return Attempt{}, err
	}
	if err := attempt.readDerived(root); err != nil {
		return Attempt{}, err
	}
	if err := attempt.verifyPinnedCatalog(); err != nil {
		return Attempt{}, err
	}
	return attempt, nil
}

// requireProtocol подтверждает существующий формат задачи.
// Отсутствующий protocol на пути чтения не создаётся.
func (t *taskState) requireProtocol() error {
	data, err := readTrusted(t.root, "protocol.json", metadataBytes, immutableMode)
	if err != nil {
		return err
	}
	value, err := decodeRecord(data)
	if err != nil || !exactFields(value, "schema", "protocolVersion") ||
		value["schema"] != json.Number("1") || value["protocolVersion"] != json.Number("2") {
		return fmt.Errorf("protocol.json: недопустимый протокол")
	}
	return nil
}

// activeAttempt проверяет указатель v2 независимо от provider-writable state.
// Неполная публикация active-attempt не признаётся попыткой.
func (t *taskState) activeAttempt(task string) (string, error) {
	data, err := readTrusted(t.root, "active-attempt.json", metadataBytes, immutableMode)
	if err != nil {
		return "", err
	}
	value, err := decodeRecord(data)
	id, _ := value["attemptId"].(string)
	if err != nil || !exactFields(value, "schema", "protocolVersion", "taskId", "attemptId") ||
		!identityMatches(value, task, id) || !attemptPattern.MatchString(id) {
		return "", fmt.Errorf("active-attempt.json: недопустимый указатель")
	}
	return id, nil
}

// decodeAttempt принимает обе схемы метаданных при одном протоколе lifecycle v2.
// Восстановление дополнительно подтверждает прежнее поколение по identity.
func decodeAttempt(value record, task, id string) (Attempt, error) {
	fields := []string{"schema", "protocolVersion", "attemptId", "taskId", "profile", "createdAt",
		"routesDir", "catalogHash", "origin", "previousAttemptId", "recoveryReason"}
	schema := value["schema"]
	if schema == json.Number("2") {
		fields = append(fields, "queueDispatchId", "runnerPrimaryOverride")
	}
	if (schema != json.Number("1") && schema != json.Number("2")) || !exactFields(value, fields...) ||
		value["protocolVersion"] != json.Number("2") || value["attemptId"] != id || value["taskId"] != task {
		return Attempt{}, fmt.Errorf("attempt.json: несовместимая identity")
	}
	profile, routes := stringField(value, "profile"), stringField(value, "routesDir")
	hash := stringField(value, "catalogHash")
	if !profilePattern.MatchString(profile) || !digestPattern.MatchString(hash) ||
		!filepath.IsAbs(routes) || filepath.Clean(routes) != routes || strings.ContainsAny(routes, "\n\t") ||
		!validTimestamp(stringField(value, "createdAt")) {
		return Attempt{}, fmt.Errorf("attempt.json: неверные данные профиля, ревизии или времени")
	}
	attempt := Attempt{ID: id, Task: task, Profile: profile, RoutesDir: routes, CatalogHash: hash}
	if schema == json.Number("2") {
		runner, ok := value["runnerPrimaryOverride"].(string)
		if !ok || (runner != "" && !runnerPattern.MatchString(runner)) {
			return Attempt{}, fmt.Errorf("attempt.json: неверный runnerPrimaryOverride")
		}
		attempt.RunnerPrimaryOverride = runner
		if value["queueDispatchId"] != nil {
			dispatch := stringField(value, "queueDispatchId")
			if !dispatchPattern.MatchString(dispatch) {
				return Attempt{}, fmt.Errorf("attempt.json: неверный queueDispatchId")
			}
			attempt.QueueDispatchID = dispatch
		}
	}
	if err := checkOrigin(value, attempt); err != nil {
		return Attempt{}, err
	}
	return attempt, nil
}

// checkOrigin различает начальное создание и восстановление прежней попытки.
// Форма причины совпадает с историческим комментарием решения человека.
func checkOrigin(value record, attempt Attempt) error {
	switch value["origin"] {
	case "fresh":
		if value["previousAttemptId"] == nil && value["recoveryReason"] == nil {
			return nil
		}
	case "recovery":
		previous := stringField(value, "previousAttemptId")
		if attemptPattern.MatchString(previous) && previous != attempt.ID &&
			validReason(stringField(value, "recoveryReason")) && attempt.QueueDispatchID == "" {
			return nil
		}
	}
	return fmt.Errorf("attempt.json: неверный источник попытки")
}

func validTimestamp(value string) bool {
	parsed, err := time.Parse(time.RFC3339, value)
	return err == nil && parsed.UTC().Format(time.RFC3339) == value
}

func validReason(value string) bool {
	return value != "" && utf8.RuneCountInString(value) <= 20000 &&
		!strings.ContainsFunc(value, func(r rune) bool {
			return r != '\n' && (r < 32 || r == 127)
		})
}

func identityMatches(value record, task, id string) bool {
	return value["schema"] == json.Number("1") && value["protocolVersion"] == json.Number("2") &&
		value["taskId"] == task && value["attemptId"] == id
}

// checkPins подтверждает принадлежность обоих закреплений immutable попытке.
// Bootstrap идентифицируется отдельным id scout того же каталога.
func (a Attempt) checkPins(value record) error {
	fields := []string{
		"schema", "protocolVersion", "taskId", "attemptId", "profile", "catalogHash", "bootstrap",
	}
	if !exactFields(value, fields...) || !identityMatches(value, a.Task, a.ID) ||
		value["profile"] != a.Profile || value["catalogHash"] != a.CatalogHash {
		return fmt.Errorf("pins.json: несовместимое закрепление")
	}
	bootstrap, _ := value["bootstrap"].(record)
	if !exactFields(bootstrap, "id", "catalogHash") || bootstrap["id"] != "scout" ||
		bootstrap["catalogHash"] != a.CatalogHash {
		return fmt.Errorf("pins.json: несовместимое закрепление bootstrap")
	}
	return nil
}

// readDerived проверяет immutable route-pin и terminal, если они уже записаны.
// Имя с SHA всегда сверяется с точными байтами файла.
func (a *Attempt) readDerived(root *os.Root) error {
	pin, err := readContentNamedRecord(root, "route-pin")
	if err != nil {
		return err
	}
	if pin != nil {
		fields := []string{"schema", "protocolVersion", "attemptId", "taskId", "profile",
			"catalogHash", "routeId", "routeHash", "selectedAt"}
		if !exactFields(pin, fields...) || !identityMatches(pin, a.Task, a.ID) ||
			pin["profile"] != a.Profile || pin["catalogHash"] != a.CatalogHash ||
			!validTimestamp(stringField(pin, "selectedAt")) {
			return fmt.Errorf("route-pin: несовместимое закрепление")
		}
		a.RouteID, a.RouteHash = stringField(pin, "routeId"), stringField(pin, "routeHash")
		if !stagePattern.MatchString(a.RouteID) || a.RouteID == "catalog" ||
			!digestPattern.MatchString(a.RouteHash) {
			return fmt.Errorf("route-pin: неверная ревизия")
		}
	}
	terminal, err := readContentNamedRecord(root, "terminal")
	if err != nil || terminal == nil {
		return err
	}
	fields := []string{"schema", "protocolVersion", "taskId", "attemptId", "state", "closedAt", "reason"}
	if !exactFields(terminal, fields...) ||
		!identityMatches(terminal, a.Task, a.ID) || !validTimestamp(stringField(terminal, "closedAt")) {
		return fmt.Errorf("terminal: несовместимое завершение")
	}
	a.Terminal = stringField(terminal, "state")
	if (a.Terminal == "finished" && terminal["reason"] == nil) ||
		(a.Terminal == "abandoned" && validReason(stringField(terminal, "reason"))) {
		return nil
	}
	return fmt.Errorf("terminal: неверная причина закрытия")
}

// verifyPinnedCatalog сравнивает выбранный маршрут с точным содержимым каталога.
// Иная текущая публикация не меняет право возобновить попытку.
func (a Attempt) verifyPinnedCatalog() error {
	reader, err := route.NewBundleReader(a.RoutesDir, a.Profile)
	if err != nil {
		return err
	}
	catalog, err := reader.ReadCatalog(a.CatalogHash)
	if err != nil {
		return err
	}
	if a.RouteID != "" && catalog.Routes[a.RouteID] != a.RouteHash {
		return fmt.Errorf("route-pin: хэш не совпадает с закреплённым catalog")
	}
	return nil
}

// readChecksummedRecord сначала проверяет байты документа по отдельному SHA.
// Проекция JSON декодируется только после совпадения physical files.
func readChecksummedRecord(root *os.Root, name string) (record, error) {
	data, err := readTrusted(root, name+".json", metadataBytes, immutableMode)
	if err != nil {
		return nil, err
	}
	hash, err := readTrusted(root, name+".sha256", 65, immutableMode)
	if err != nil {
		return nil, err
	}
	if string(hash) != digestOf(data)+"\n" {
		return nil, fmt.Errorf("%s: checksum не совпадает", name)
	}
	return decodeRecord(data)
}

// readContentNamedRecord допускает один файл данного типа.
// Файл с неожиданным именем или вторым хэшем означает повреждение попытки.
func readContentNamedRecord(root *os.Root, prefix string) (record, error) {
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil, err
	}
	name := ""
	for _, entry := range entries {
		candidate := entry.Name()
		if strings.HasPrefix(candidate, prefix+".") && strings.HasSuffix(candidate, ".json") {
			if name != "" {
				return nil, fmt.Errorf("%s: несколько записей одного вида", prefix)
			}
			name = candidate
		}
	}
	if name == "" {
		return nil, nil
	}
	data, err := readTrusted(root, name, metadataBytes, immutableMode)
	if err != nil {
		return nil, err
	}
	if name != prefix+"."+digestOf(data)+".json" {
		return nil, fmt.Errorf("%s: хэш записи не совпадает", prefix)
	}
	return decodeRecord(data)
}

// decodeRecord принимает один UTF-8 объект из отдельной записи.
// Скаляр, null и приписанный JSON после первого объекта отвергаются.
func decodeRecord(data []byte) (record, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value record
	var extra any
	if !utf8.Valid(data) || decoder.Decode(&value) != nil || value == nil ||
		decoder.Decode(&extra) != io.EOF {
		return nil, fmt.Errorf("state: ожидался один объект JSON в UTF-8")
	}
	return value, nil
}

func stringField(value record, field string) string {
	text, _ := value[field].(string)
	return text
}

// exactFields ограничивает форму документа его собственной схемой.
// Дополнительные метаданные нельзя принять как часть уже выпущенной версии.
func exactFields(value record, fields ...string) bool {
	if len(value) != len(fields) {
		return false
	}
	for name := range value {
		if !slices.Contains(fields, name) {
			return false
		}
	}
	return true
}

func digestOf(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}
