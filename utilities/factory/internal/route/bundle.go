package route

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
	"sort"
	"strings"
	"unicode/utf8"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

type object = map[string]any

var (
	profilePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	entityPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,40}$`)
	digestPattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	promptPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,40}(\.[a-z0-9][a-z0-9_-]{0,40})*\.md$`)
)

type BundleReader struct {
	dir     string
	profile string
}

type CatalogBundle struct {
	Hash      string
	Routes    map[string]string
	Bootstrap MachineBundle
}

type MachineBundle struct {
	Hash    string
	Machine object
	Prompts map[string]string
	model   machineModel
}

// NewBundleReader связывает чтение с одним профилем в указанном хранилище.
// Идентификатор проверяется до построения пути.
func NewBundleReader(dir, profile string) (BundleReader, error) {
	if !profilePattern.MatchString(profile) {
		return BundleReader{}, fmt.Errorf("profile: недопустимый идентификатор")
	}
	return BundleReader{dir: dir, profile: profile}, nil
}

// ReadCurrent загружает каталог по опубликованному указателю.
// Все маршруты проверяются до возвращения закреплений вызывающему коду.
func (r BundleReader) ReadCurrent() (CatalogBundle, error) {
	store, err := r.openStore()
	if err != nil {
		return CatalogBundle{}, err
	}
	defer store.Close()

	currentPath := filepath.Join(r.profile, "catalog")
	dir, err := openDirectory(store, currentPath)
	if err != nil {
		return CatalogBundle{}, err
	}
	defer dir.Close()
	pointer, err := readCanonicalObject(dir, "current.json")
	if err != nil {
		return CatalogBundle{}, err
	}
	if err := exactKeys(pointer, "current", "schema", "catalogHash"); err != nil {
		return CatalogBundle{}, err
	}
	if !schemaV2(pointer) {
		return CatalogBundle{}, fmt.Errorf("current.schema: поддерживается только v2")
	}
	hash, err := identifier(pointer["catalogHash"], digestPattern, "current.catalogHash")
	if err != nil {
		return CatalogBundle{}, err
	}
	return r.readCatalog(store, hash)
}

// ReadCatalog загружает каталог по неизменяемому адресу.
// Закреплённая попытка не обращается к указателю current.
func (r BundleReader) ReadCatalog(hash string) (CatalogBundle, error) {
	store, err := r.openStore()
	if err != nil {
		return CatalogBundle{}, err
	}
	defer store.Close()
	return r.readCatalog(store, hash)
}

// ReadRoute проверяет файлы по закреплённому каталогу и имени маршрута.
// Прямой путь от вызывающего кода не разрешает обойти хэш и адрес ревизии.
func (r BundleReader) ReadRoute(id, hash string) (MachineBundle, error) {
	store, err := r.openStore()
	if err != nil {
		return MachineBundle{}, err
	}
	defer store.Close()
	return r.readRoute(store, id, hash)
}

// openStore отклоняет символические ссылки во всём лексическом адресе хранилища.
// Открытый Root ограничивает дальнейшие операции проверенным деревом.
func (r BundleReader) openStore() (*os.Root, error) {
	absolute, err := filepath.Abs(r.dir)
	if err != nil {
		return nil, fmt.Errorf("routes root недоступен: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, fmt.Errorf("%s: routes root недоступен: %w", absolute, err)
	}
	if absolute != resolved {
		return nil, fmt.Errorf("%s: symlink/не-каталог в routes root", absolute)
	}
	store, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, fmt.Errorf("%s: routes root недоступен: %w", absolute, err)
	}
	return store, nil
}

// openDirectory проверяет каждый компонент адреса внутри ранее открытого каталога.
// Даже ссылка на каталог внутри хранилища исключается из структуры бандла.
func openDirectory(root *os.Root, name string) (*os.Root, error) {
	current := ""
	for part := range strings.SplitSeq(name, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := root.Lstat(current)
		if err != nil {
			return nil, fmt.Errorf("%s: каталог bundle недоступен: %w", current, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("%s: symlink/не-каталог в адресе bundle", current)
		}
	}
	return root.OpenRoot(name)
}

// readCatalog проверяет метаданные каталога, bootstrap и каждую закреплённую ревизию.
// Результат возвращается целиком, когда все файлы совпали с опубликованным manifest.
func (r BundleReader) readCatalog(store *os.Root, hash string) (CatalogBundle, error) {
	if _, err := identifier(hash, digestPattern, "catalog hash"); err != nil {
		return CatalogBundle{}, err
	}
	dir, err := openDirectory(store, filepath.Join(r.profile, "catalog", "revisions", hash))
	if err != nil {
		return CatalogBundle{}, err
	}
	defer dir.Close()
	files, err := r.verifyBundle(dir, "catalog", "", hash)
	if err != nil {
		return CatalogBundle{}, err
	}

	catalog, err := canonicalObject(files["catalog.json"], "catalog.json")
	if err != nil {
		return CatalogBundle{}, err
	}
	routes, err := r.catalogRoutes(catalog)
	if err != nil {
		return CatalogBundle{}, err
	}
	bootstrap, err := decodeMachine(files, "bootstrap/scout.json", hash)
	if err != nil {
		return CatalogBundle{}, err
	}
	bootstrap.model, err = validateMachine(bootstrap, r.profile, "scout", "bootstrap", true)
	if err != nil {
		return CatalogBundle{}, err
	}
	if err := validateCatalogReferences(bootstrap.Machine, routes, "bootstrap"); err != nil {
		return CatalogBundle{}, err
	}
	for _, id := range sortedKeys(routes) {
		bundle, err := r.readRoute(store, id, routes[id])
		if err != nil {
			return CatalogBundle{}, err
		}
		if err := validateCatalogReferences(bundle.Machine, routes, "route."+id); err != nil {
			return CatalogBundle{}, err
		}
	}
	return CatalogBundle{Hash: hash, Routes: routes, Bootstrap: bootstrap}, nil
}

// catalogRoutes проверяет схему метаданных прежде, чем превращать ключи в пути.
// Каждый маршрут должен быть закреплён за валидным SHA-256.
func (r BundleReader) catalogRoutes(catalog object) (map[string]string, error) {
	if err := exactKeys(catalog, "catalog", "schema", "profile", "routes", "bootstrap"); err != nil {
		return nil, err
	}
	if err := checkNoModelPolicy(catalog, "catalog"); err != nil {
		return nil, err
	}
	if !schemaV2(catalog) || catalog["profile"] != r.profile {
		return nil, fmt.Errorf("catalog: schema/profile не совпадают")
	}
	bootstrap, ok := catalog["bootstrap"].(object)
	if !ok || len(bootstrap) != 1 || bootstrap["file"] != "bootstrap/scout.json" {
		return nil, fmt.Errorf("catalog.bootstrap: разрешён только bootstrap/scout.json")
	}
	declared, ok := catalog["routes"].(object)
	if !ok || len(declared) == 0 {
		return nil, fmt.Errorf("catalog.routes: нужен хотя бы один маршрут")
	}
	routes := make(map[string]string, len(declared))
	for id, value := range declared {
		label := "catalog.routes." + id
		if err := checkRouteID(id, label); err != nil {
			return nil, err
		}
		hash, err := identifier(value, digestPattern, label)
		if err != nil {
			return nil, err
		}
		routes[id] = hash
	}
	return routes, nil
}

// readRoute открывает объявленный bundle после проверки имени и номера ревизии.
// Документ и промпты читаются из набора байтов, сверенных с manifest.
func (r BundleReader) readRoute(store *os.Root, id, hash string) (MachineBundle, error) {
	if err := checkRouteID(id, "route"); err != nil {
		return MachineBundle{}, err
	}
	if _, err := identifier(hash, digestPattern, "route hash"); err != nil {
		return MachineBundle{}, err
	}
	dir, err := openDirectory(store, filepath.Join(r.profile, id, "revisions", hash))
	if err != nil {
		return MachineBundle{}, err
	}
	defer dir.Close()
	files, err := r.verifyBundle(dir, "route", id, hash)
	if err != nil {
		return MachineBundle{}, err
	}
	bundle, err := decodeMachine(files, "route.json", hash)
	if err != nil {
		return MachineBundle{}, err
	}
	bundle.model, err = validateMachine(bundle, r.profile, id, "route", true)
	if err != nil {
		return MachineBundle{}, err
	}
	return bundle, nil
}

// validateCatalogReferences сверяет каждую эскалацию с фактическим каталогом.
// Разрешение в отдельной машине не создаёт новую ревизию другого маршрута.
func validateCatalogReferences(machine object, routes map[string]string, label string) error {
	for _, raw := range arrayValue(machine["escalation"]) {
		targets := arrayValue(objectValue(raw)["allowedRoutes"])
		if err := requireCatalogRoutes(targets, routes, label+".escalation"); err != nil {
			return err
		}
	}
	for _, raw := range arrayValue(machine["nodes"]) {
		node := objectValue(raw)
		for _, channel := range []string{"on", "onFailure"} {
			transitions := objectValue(node[channel])
			for _, outcome := range sortedKeys(transitions) {
				targets := arrayValue(objectValue(objectValue(transitions[outcome])["escalate"])["routes"])
				if err := requireCatalogRoutes(targets, routes, label+"."+channel); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// requireCatalogRoutes сохраняет адрес проверки и порядок диагностики.
// Все ссылки из переданного набора должны существовать в той же ревизии каталога.
func requireCatalogRoutes(targets []any, routes map[string]string, label string) error {
	var missing []string
	for _, raw := range targets {
		id := textValue(raw)
		if _, exists := routes[id]; !exists {
			missing = append(missing, id)
		}
	}
	if len(missing) != 0 {
		sort.Strings(missing)
		return fmt.Errorf("%s: маршруты отсутствуют в catalog: %s", label, strings.Join(missing, ", "))
	}
	return nil
}

// decodeMachine читает машинный JSON без его повторной канонизации.
// Промпт и сам документ уже закреплены точными байтами manifest.
func decodeMachine(files map[string][]byte, name, hash string) (MachineBundle, error) {
	machine, err := parseObject(files[name], name)
	if err != nil {
		return MachineBundle{}, err
	}
	prompts := make(map[string]string)
	for name, content := range files {
		if strings.HasSuffix(name, ".md") {
			if !utf8.Valid(content) {
				return MachineBundle{}, fmt.Errorf("%s: промпт не UTF-8", name)
			}
			prompts[name] = string(content)
		}
	}
	return MachineBundle{Hash: hash, Machine: machine, Prompts: prompts}, nil
}

// verifyBundle сначала сверяет адрес manifest, затем читает объявленные файлы.
// Никакие необъявленные файлы и каталоги не входят в проверенную ревизию.
func (r BundleReader) verifyBundle(dir *os.Root, kind, id, expected string) (map[string][]byte, error) {
	raw, err := readRegular(dir, "manifest.json")
	if err != nil {
		return nil, err
	}
	if sha256Hex(raw) != expected {
		return nil, fmt.Errorf("%s: hash manifest не совпадает с именем ревизии", dir.Name())
	}
	manifest, err := canonicalObject(raw, "manifest.json")
	if err != nil {
		return nil, err
	}
	keys := []string{"schema", "kind", "profile", "algorithm", "files"}
	if kind == "route" {
		keys = append(keys, "id")
	}
	if err := exactKeys(manifest, "manifest", keys...); err != nil {
		return nil, err
	}
	if !schemaV2(manifest) || manifest["kind"] != kind || manifest["profile"] != r.profile ||
		manifest["algorithm"] != "sha256" || (kind == "route" && manifest["id"] != id) {
		return nil, fmt.Errorf("manifest: адрес и метаданные bundle не совпадают")
	}
	entries, ok := manifest["files"].([]any)
	if !ok || len(entries) == 0 {
		return nil, fmt.Errorf("manifest.files: нужен непустой массив")
	}
	return readBundleFiles(dir, kind, entries)
}

// readBundleFiles проверяет размеры, хэши и строгий порядок объявленных путей.
// Проверка дерева подтверждает набор прочитанных файлов и ожидаемые каталоги.
func readBundleFiles(dir *os.Root, kind string, entries []any) (map[string][]byte, error) {
	files := make(map[string][]byte, len(entries))
	last := ""
	for index, value := range entries {
		name, content, err := readManifestEntry(dir, kind, last, index, value)
		if err != nil {
			return nil, err
		}
		files[name] = content
		last = name
	}
	required := []string{"route.json"}
	if kind == "catalog" {
		required = []string{"catalog.json", "bootstrap/scout.json"}
	}
	for _, name := range required {
		if _, ok := files[name]; !ok {
			return nil, fmt.Errorf("bundle: отсутствуют обязательные файлы [%s]", name)
		}
	}
	if err := verifyTree(dir, kind, files); err != nil {
		return nil, err
	}
	return files, nil
}

// readManifestEntry проверяет один элемент прежде, чем использовать его путь.
// Размер и хэш рассчитываются для тех же байтов, которые передаются в декодер.
func readManifestEntry(dir *os.Root, kind, last string, index int, value any) (string, []byte, error) {
	label := fmt.Sprintf("manifest.files[%d]", index)
	entry, _ := value.(object)
	if err := exactKeys(entry, label, "path", "sha256", "size"); err != nil {
		return "", nil, err
	}
	name, ok := entry["path"].(string)
	if !ok || !safeBundlePath(kind, name) {
		return "", nil, fmt.Errorf("%s.path: небезопасный путь", label)
	}
	if name <= last {
		return "", nil, fmt.Errorf("manifest.files: пути должны быть уникальны и отсортированы")
	}
	hash, err := identifier(entry["sha256"], digestPattern, label+".sha256")
	if err != nil {
		return "", nil, err
	}
	number, _ := entry["size"].(json.Number)
	size, err := number.Int64()
	if err != nil || size < 0 {
		return "", nil, fmt.Errorf("%s.size: недопустимый размер", label)
	}
	content, err := readRegular(dir, filepath.FromSlash(name))
	if err != nil {
		return "", nil, err
	}
	if int64(len(content)) != size || sha256Hex(content) != hash {
		return "", nil, fmt.Errorf("%s: содержимое не совпадает с manifest", name)
	}
	return name, content, nil
}

// safeBundlePath допускает фиксированные служебные файлы и имена промптов.
// Регулярное выражение запрещает вложенные, абсолютные и относительные пути промптов.
func safeBundlePath(kind, name string) bool {
	if kind == "route" {
		return name == "route.json" || strings.HasPrefix(name, "prompts/") &&
			promptPattern.MatchString(strings.TrimPrefix(name, "prompts/"))
	}
	return name == "catalog.json" || name == "bootstrap/scout.json" ||
		strings.HasPrefix(name, "bootstrap/prompts/") &&
			promptPattern.MatchString(strings.TrimPrefix(name, "bootstrap/prompts/"))
}

// verifyTree перечисляет фактическое дерево под открытым дескриптором.
// Лишний файл, ссылка и незаявленный каталог приводят к отказу.
func verifyTree(dir *os.Root, kind string, declared map[string][]byte) error {
	directories := map[string]bool{"prompts": kind == "route", "bootstrap": kind == "catalog",
		"bootstrap/prompts": kind == "catalog"}
	count := 0
	err := fs.WalkDir(dir.FS(), ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || name == "." {
			return err
		}
		if entry.IsDir() {
			if !directories[name] {
				return fmt.Errorf("%s: лишний каталог bundle", name)
			}
			for file := range declared {
				if strings.HasPrefix(file, name+"/") {
					return nil
				}
			}
			return fmt.Errorf("%s: лишний пустой каталог bundle", name)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("%s: bundle содержит не обычный файл", name)
		}
		if _, exists := declared[name]; name != "manifest.json" && !exists {
			return fmt.Errorf("bundle: фактический набор файлов не совпадает с manifest")
		}
		count++
		return nil
	})
	if err != nil {
		return err
	}
	if count != len(declared)+1 {
		return fmt.Errorf("bundle: фактический набор файлов не совпадает с manifest")
	}
	return nil
}

// readRegular открывает обычный файл с запретом ссылки и без блокировки на FIFO.
// Проверка дескриптора остаётся действительной при замене имени во время чтения.
func readRegular(root *os.Root, name string) ([]byte, error) {
	return readRegularLimit(root, name, 0)
}

// readRegularLimit держит ограничение размера на открытом файле.
// Лимит учитывает изменение длины между stat и фактическим чтением.
func readRegularLimit(root *os.Root, name string, limit int64) ([]byte, error) {
	file, err := host.OpenAt(root, name, os.O_RDONLY, 0, host.Nonblocking)
	if err != nil {
		return nil, fmt.Errorf("%s: файл недоступен: %w", name, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s: ожидался обычный файл без symlink", name)
	}
	var input io.Reader = file
	if limit > 0 {
		if info.Size() > limit {
			return nil, fmt.Errorf("%s: файл превышает допустимый размер", name)
		}
		input = io.LimitReader(file, limit+1)
	}
	value, err := io.ReadAll(input)
	if err != nil {
		return nil, fmt.Errorf("%s: файл не читается: %w", name, err)
	}
	if limit > 0 && int64(len(value)) > limit {
		return nil, fmt.Errorf("%s: файл превышает допустимый размер", name)
	}
	return value, nil
}

// readCanonicalObject читает один физический JSON-файл и проверяет его точные байты.
// Указатель и manifest должны совпадать с форматом публикации.
func readCanonicalObject(root *os.Root, name string) (object, error) {
	raw, err := readRegular(root, name)
	if err != nil {
		return nil, err
	}
	return canonicalObject(raw, name)
}

// canonicalObject принимает объект в канонической сериализации.
// Проверка повторным кодированием исключает лишние пробелы и дубли ключей.
func canonicalObject(raw []byte, label string) (object, error) {
	value, err := parseObject(raw, label)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	if err := WriteJSON(&output, value); err != nil {
		return nil, err
	}
	if !bytes.Equal(raw, output.Bytes()) {
		return nil, fmt.Errorf("%s: JSON записан не в каноническом формате", label)
	}
	return value, nil
}

// parseObject принимает один объект в UTF-8 и сохраняет точность целых чисел.
// Данные после конечной скобки не относятся к объявленному документу.
func parseObject(raw []byte, label string) (object, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value object
	var extra any
	if !utf8.Valid(raw) || decoder.Decode(&value) != nil || decoder.Decode(&extra) != io.EOF {
		return nil, fmt.Errorf("%s: повреждённый JSON", label)
	}
	if value == nil {
		return nil, fmt.Errorf("%s: ожидался объект", label)
	}
	return value, nil
}

// WriteJSON использует формат вывода route CLI с вложенными отступами.
// Текст в UTF-8 сохраняется в ответах описания маршрута.
func WriteJSON(out io.Writer, value any) error {
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

// exactKeys сверяет контракт объекта и даёт стабильный порядок полей в диагностике.
// Неполный или расширенный формат требует явной поддержки текущего поколения.
func exactKeys(value object, label string, required ...string) error {
	if value == nil {
		return fmt.Errorf("%s: ожидался объект", label)
	}
	var missing []string
	for _, field := range required {
		if _, exists := value[field]; !exists {
			missing = append(missing, field)
		}
	}
	if len(missing) != 0 {
		sort.Strings(missing)
		return fmt.Errorf("%s: отсутствуют поля %s", label, strings.Join(missing, ", "))
	}
	if len(value) != len(required) {
		var unknown []string
		for field := range value {
			if !slices.Contains(required, field) {
				unknown = append(unknown, field)
			}
		}
		sort.Strings(unknown)
		return fmt.Errorf("%s: неизвестные поля %s", label, strings.Join(unknown, ", "))
	}
	return nil
}

// identifier принимает только строковое значение, прошедшее нужную грамматику.
// Метка сохраняется в диагностике перед использованием идентификатора как ключа.
func identifier(value any, pattern *regexp.Regexp, label string) (string, error) {
	id, ok := value.(string)
	if !ok || !pattern.MatchString(id) {
		return "", fmt.Errorf("%s: недопустимый идентификатор", label)
	}
	return id, nil
}

// checkRouteID защищает служебное имя каталога от использования в адресе маршрута.
// Остальные имена следуют той же грамматике, что и узлы маршрута.
func checkRouteID(id, label string) error {
	if _, err := identifier(id, entityPattern, label); err != nil {
		return err
	}
	if id == "catalog" {
		return fmt.Errorf("%s: catalog зарезервирован хранилищем", label)
	}
	return nil
}

func schemaV2(value object) bool {
	return value["schema"] == json.Number("2")
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
