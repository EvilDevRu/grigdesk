package local

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

type InstallSpec struct {
	Package         Package
	Directory       string
	BootstrapPython string
	Client          *http.Client
	Run             Runner
	Log             func(string)
	Timeout         time.Duration
	CommandTimeout  time.Duration
	DownloadTimeout time.Duration
}

type InstallResult struct {
	Engine   string `json:"engineId"`
	Package  string `json:"packageId"`
	Manifest string `json:"manifestPath"`
}

type modelFile struct {
	name   string
	digest string
}

type layout struct {
	engine   string
	runtimes string
	current  string
	target   string
	cache    string
	bytes    int64
	digest   string
	files    []modelFile
}

var packageName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)
var requirement = regexp.MustCompile(`^[a-zA-Z0-9_.-]+==[a-zA-Z0-9_.+-]+$`)

// Install проверяет модель и Python в отдельных staging и runtime каталогах.
// После приёмки обновляется ссылка venv, а при отказе убирается только своя generation.
func Install(ctx context.Context, spec InstallSpec) (InstallResult, error) {
	if err := validatePackage(spec.Package); err != nil {
		return InstallResult{}, err
	}
	if spec.Timeout == 0 {
		spec.Timeout = 30 * time.Minute
	}
	if spec.Timeout < 0 || spec.CommandTimeout < 0 || spec.DownloadTimeout < 0 {
		return InstallResult{}, voicecore.Failed("Срок установки должен быть положительным.")
	}
	if spec.Run == nil {
		spec.Run = Run
	}
	if spec.Log == nil {
		spec.Log = func(string) {}
	}
	bounded, cancel := context.WithTimeout(ctx, spec.Timeout)
	defer cancel()
	result, err := install(bounded, spec)
	if ctx.Err() != nil {
		return InstallResult{}, voicecore.Failed("Установка отменена.")
	}
	if bounded.Err() != nil {
		return InstallResult{}, voicecore.Failed("Истёк общий срок установки.")
	}
	return result, err
}

// install владеет lock, директорией подготовки и при необходимости новым venv.
// Полный кэш сначала подтверждается хешем, потом разрешается создание модели.
func install(ctx context.Context, spec InstallSpec) (InstallResult, error) {
	if err := ctx.Err(); err != nil {
		return InstallResult{}, err
	}
	paths := selectedLayout(spec.Package, spec.Directory)
	cacheDir := filepath.Dir(paths.cache)
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return InstallResult{}, err
	}
	release, err := acquireLock(filepath.Join(cacheDir, "install.lock"))
	if err != nil {
		return InstallResult{}, err
	}
	defer release()
	spec.Log("Проверяю пакет " + spec.Package.EngineID + "/" + spec.Package.ID + ".")
	download := DownloadSpec{
		URL:     spec.Package.URL,
		Path:    paths.cache,
		SHA256:  paths.digest,
		Bytes:   paths.bytes,
		Timeout: spec.DownloadTimeout,
		Client:  spec.Client,
	}
	if err := Download(ctx, download); err != nil {
		return InstallResult{}, err
	}
	work, err := os.MkdirTemp(cacheDir, "install-")
	if err != nil {
		return InstallResult{}, err
	}
	defer os.RemoveAll(work)
	return stageAndPublish(ctx, spec, paths, work)
}

// stageAndPublish перепроверяет окружение и принимает настоящую контрольную реплику.
// Неудачный кандидат остаётся недоступным читателям принятого манифеста.
func stageAndPublish(
	ctx context.Context, spec InstallSpec, paths layout, work string,
) (InstallResult, error) {
	staging := filepath.Join(work, "model")
	if err := stageModel(ctx, spec.Package, paths, staging); err != nil {
		return InstallResult{}, err
	}
	if err := os.MkdirAll(paths.runtimes, 0o700); err != nil {
		return InstallResult{}, err
	}
	runtime, err := reusable(ctx, spec, paths)
	if err != nil {
		return InstallResult{}, err
	}
	published := false
	if runtime == "" {
		runtime = filepath.Join(paths.runtimes, voicecore.UUID())
		defer func() {
			if !published {
				_ = os.RemoveAll(runtime)
			}
		}()
		spec.Log("Создаю отдельное Python-окружение и ставлю закреплённые зависимости.")
		if err := prepareRuntime(ctx, spec, runtime, work); err != nil {
			return InstallResult{}, err
		}
	}
	spec.Log("Проверяю модель контрольной фразой.")
	if err := accept(ctx, spec, runtime, staging, work); err != nil {
		return InstallResult{}, err
	}
	manifest, err := publish(ctx, spec.Package, paths, staging, runtime, work)
	if err != nil {
		return InstallResult{}, err
	}
	published = true
	return InstallResult{Engine: spec.Package.EngineID, Package: spec.Package.ID, Manifest: manifest}, nil
}

// validatePackage допускает только каталожные имена и закреплённые зависимости.
// Тестовая спецификация проходит те же ограничения, что и рабочий пакет.
func validatePackage(pack Package) error {
	names := []string{pack.ID}
	switch pack.EngineID {
	case "piper":
		names = append(names, pack.ModelName, pack.ConfigName)
	case "silero":
		if len(pack.Speakers) == 0 {
			return voicecore.Failed("Пакет Silero не содержит ни одного диктора.")
		}
		names = append(names, pack.FileName)
		for _, speaker := range pack.Speakers {
			names = append(names, speaker.ID)
		}
	default:
		return voicecore.Usage("Установка доступна для piper или silero.")
	}
	for _, name := range names {
		if !packageName.MatchString(name) {
			return voicecore.Failed("Каталог модели содержит недопустимое имя файла или пакета.")
		}
	}
	if len(pack.Requirements) == 0 {
		return voicecore.Failed("Каждая зависимость движка должна иметь закреплённую версию.")
	}
	for _, line := range pack.Requirements {
		if !requirement.MatchString(line) {
			return voicecore.Failed("Каждая зависимость движка должна иметь закреплённую версию.")
		}
	}
	return nil
}

// selectedLayout получает пути только из выбранного пакета и каталога voice.
// Имена совместимы с сохранённым кэшем и активными venv предыдущей установки.
func selectedLayout(pack Package, root string) layout {
	engine := pack.EngineRoot(root)
	paths := layout{
		engine:   engine,
		runtimes: filepath.Join(engine, "runtimes"),
		current:  filepath.Join(engine, "venv"),
		target:   pack.ModelRoot(root),
	}
	if pack.EngineID == "piper" {
		paths.cache = filepath.Join(root, "cache", "piper-"+pack.ID+".tar.gz")
		paths.bytes, paths.digest = pack.ArchiveBytes, pack.ArchiveSHA256
		paths.files = []modelFile{{name: pack.ModelName, digest: pack.ModelSHA256},
			{name: pack.ConfigName, digest: pack.ConfigSHA256}}
	} else {
		paths.cache = filepath.Join(root, "cache", "silero-"+pack.ID+".pt")
		paths.bytes, paths.digest = pack.FileBytes, pack.FileSHA256
		paths.files = []modelFile{{name: pack.FileName, digest: pack.FileSHA256}}
	}
	return paths
}

// prepareRuntime создаёт venv в постоянной generation и записывает marker после проверки.
// Активный venv при pip, ошибке или отмене не меняется.
func prepareRuntime(ctx context.Context, spec InstallSpec, target, work string) error {
	bootstrap := spec.BootstrapPython
	if bootstrap == "" {
		bootstrap = "python3"
	}
	venvArgs := []string{"-m", "venv", target}
	if _, err := spec.Run(ctx, bootstrap, venvArgs, "", spec.command(time.Minute)); err != nil {
		return err
	}
	requirements := filepath.Join(work, "requirements.txt")
	pins := strings.Join(spec.Package.Requirements, "\n") + "\n"
	if err := os.WriteFile(requirements, []byte(pins), 0o600); err != nil {
		return err
	}
	args := []string{"-m", "pip", "install", "-r", requirements}
	if value := spec.Package.RequirementsIndexURL; value != nil && *value != "" {
		args = append(args, "--index-url", *value)
	}
	python := filepath.Join(target, "bin", "python")
	if _, err := spec.Run(ctx, python, args, "", spec.command(20*time.Minute)); err != nil {
		return err
	}
	if err := probeRuntime(ctx, spec, python); err != nil {
		return err
	}
	data, _ := json.Marshal(runtimeMarker{Schema: 1, Fingerprint: fingerprint(spec.Package)})
	return os.WriteFile(filepath.Join(target, ".voice-runtime.json"), data, 0o600)
}

type runtimeMarker struct {
	Schema      int    `json:"schemaVersion"`
	Fingerprint string `json:"fingerprint"`
}

// reusable принимает только generation внутри собственного runtimes с корректным marker.
// Проверка версий и импортов повторяется перед реальным использованием окружения.
func reusable(ctx context.Context, spec InstallSpec, paths layout) (string, error) {
	info, err := os.Lstat(paths.current)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return "", voicecore.Failed("Путь venv занят обычным каталогом; его автоматическая замена запрещена.")
	}
	current, err := filepath.EvalSymlinks(paths.current)
	if err != nil {
		return "", nil
	}
	root, err := filepath.EvalSymlinks(paths.runtimes)
	if err != nil || filepath.Dir(current) != root {
		return "", voicecore.Failed("Ссылка venv указывает за пределы собственных runtime generations.")
	}
	data, err := os.ReadFile(filepath.Join(current, ".voice-runtime.json"))
	var marker runtimeMarker
	if err != nil || json.Unmarshal(data, &marker) != nil || marker.Schema != 1 ||
		marker.Fingerprint != fingerprint(spec.Package) {
		return "", nil
	}
	if err := probeRuntime(ctx, spec, filepath.Join(current, "bin", "python")); err != nil {
		return "", ctx.Err()
	}
	return current, nil
}

// fingerprint воспроизводит сохранённую опись версии среды Python.
// Данные модели и порядок ключей пользовательских настроек на неё не влияют.
func fingerprint(pack Package) string {
	data, _ := json.Marshal(struct {
		Schema       int      `json:"schemaVersion"`
		Engine       string   `json:"engineId"`
		Requirements []string `json:"requirements"`
		Index        *string  `json:"requirementsIndexUrl"`
	}{Schema: 1, Engine: pack.EngineID, Requirements: pack.Requirements, Index: pack.RequirementsIndexURL})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

// probeRuntime проверяет модули и точные версии через последний JSON-факт venv.
// Живое окружение допускается только при совпадении полного набора.
func probeRuntime(ctx context.Context, spec InstallSpec, python string) error {
	modules, duration := []string{"piper", "onnxruntime"}, 15*time.Second
	if spec.Package.EngineID == "silero" {
		modules, duration = []string{"torch"}, 90*time.Second
	}
	var packages []string
	expected := make(map[string]string)
	for _, item := range spec.Package.Requirements {
		name, version, _ := strings.Cut(item, "==")
		packages = append(packages, name)
		expected[name] = version
	}
	mods, _ := json.Marshal(modules)
	names, _ := json.Marshal(packages)
	const start = "import importlib, importlib.metadata, json\nmodules = %s\npackages = %s\n"
	program := fmt.Sprintf(start, mods, names) +
		"for name in modules: importlib.import_module(name)\n" +
		"versions = {name: importlib.metadata.version(name) for name in packages}\n" +
		"print(json.dumps({'versions': versions}, sort_keys=True))"
	reply, err := spec.Run(ctx, python, []string{"-c", program}, "", spec.command(duration))
	if err != nil {
		return err
	}
	var result struct {
		Versions map[string]string `json:"versions"`
	}
	if json.Unmarshal(lastLine(reply), &result) != nil || !maps.Equal(result.Versions, expected) {
		return voicecore.Failed("Состав Python-окружения не совпал с закреплёнными версиями.")
	}
	return nil
}

func (spec InstallSpec) command(fallback time.Duration) time.Duration {
	if spec.CommandTimeout != 0 {
		return spec.CommandTimeout
	}
	return fallback
}

// stageModel раскладывает только файлы закреплённой модели в собственный staging.
// Каждый результат проверяется на подлинные байты отдельно от хеша архива.
func stageModel(ctx context.Context, pack Package, paths layout, staging string) error {
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return err
	}
	var err error
	if pack.EngineID == "piper" {
		err = unpackPiper(ctx, paths, staging)
	} else {
		err = copyFile(paths.cache, filepath.Join(staging, pack.FileName))
	}
	if err != nil {
		return err
	}
	for _, model := range paths.files {
		digest, err := fileDigest(ctx, filepath.Join(staging, model.name))
		if err != nil || digest != model.digest {
			return voicecore.Failed("Файл " + model.name + " не совпал с закреплённой моделью.")
		}
	}
	return nil
}

// unpackPiper пишет только два разрешённых обычных файла из tar.gz.
// Дубли, ссылки и отсутствие закреплённых элементов делают staging неприемлемым.
func unpackPiper(ctx context.Context, paths layout, staging string) error {
	bounded, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	archive, err := os.Open(paths.cache)
	if err != nil {
		return err
	}
	defer archive.Close()
	compressed, err := gzip.NewReader(archive)
	if err != nil {
		return err
	}
	defer compressed.Close()
	input := tar.NewReader(compressed)
	selected := make(map[string]bool)
	for _, model := range paths.files {
		selected[model.name] = false
	}
	const missing = "В архиве Piper нет однозначного закреплённого файла."
	for bounded.Err() == nil {
		header, err := input.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := header.Name
		for strings.HasPrefix(name, "./") {
			name = name[2:]
		}
		seen, wanted := selected[name]
		if !wanted {
			continue
		}
		if seen || header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return voicecore.Failed(missing)
		}
		if err := writeFile(filepath.Join(staging, name), input); err != nil {
			return err
		}
		selected[name] = true
	}
	for _, seen := range selected {
		if !seen {
			return voicecore.Failed(missing)
		}
	}
	return bounded.Err()
}

func copyFile(from, to string) error {
	input, err := os.Open(from)
	if err != nil {
		return err
	}
	defer input.Close()
	return writeFile(to, input)
}

// writeFile создаёт приватный временный файл, сохраняя целость пути назначения.
// Потоки закрываются до публикации полученной копии.
func writeFile(path string, input io.Reader) error {
	output, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(output, input)
	return errors.Join(err, output.Close())
}

// accept синтезирует контрольную фразу из staged файлов принятым Python.
// Активные файлы не участвуют в проверке нового комплекта.
func accept(ctx context.Context, spec InstallSpec, runtime, staging, work string) error {
	request := Synthesis{
		Engine:  spec.Package.EngineID,
		Python:  filepath.Join(runtime, "bin", "python"),
		Output:  filepath.Join(work, "accept.wav"),
		Text:    "проверка связи",
		Pace:    "normal",
		Timeout: spec.command(300 * time.Second),
	}
	if spec.Package.EngineID == "piper" {
		request.Model = filepath.Join(staging, spec.Package.ModelName)
		request.Config = filepath.Join(staging, spec.Package.ConfigName)
	} else {
		request.Model = filepath.Join(staging, spec.Package.FileName)
		request.Speaker = spec.Package.Speakers[0].ID
	}
	_, err := Synthesize(ctx, request, spec.Run)
	return err
}

// publish переключает действующую ссылку после полной записи модели и манифеста.
// Каждая опубликованная запись становится видна через переименование соседнего файла.
func publish(ctx context.Context, pack Package, paths layout, staging, runtime, work string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.MkdirAll(paths.target, 0o700); err != nil {
		return "", err
	}
	for _, model := range paths.files {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		target := filepath.Join(paths.target, model.name)
		if err := publishFile(filepath.Join(staging, model.name), target); err != nil {
			return "", err
		}
	}
	stageManifest := filepath.Join(work, "voice.json")
	if err := os.WriteFile(stageManifest, manifestData(pack), 0o600); err != nil {
		return "", err
	}
	manifest := filepath.Join(paths.target, "voice.json")
	if err := publishFile(stageManifest, manifest); err != nil {
		return "", err
	}
	if err := publishVenv(ctx, paths, runtime); err != nil {
		return "", err
	}
	return manifest, nil
}

// manifestData сохраняет прежние поля, которые читают установленные движки.
// Локальные каталоги Piper и Silero имеют разные обязательные поля.
func manifestData(pack Package) []byte {
	manifest := map[string]any{
		"id": pack.ID, "name": pack.Name, "language": pack.Language, "sampleRate": pack.SampleRate,
	}
	if pack.EngineID == "piper" {
		manifest["timbre"] = pack.Timbre
		manifest["model"] = pack.ModelName
		manifest["config"] = pack.ConfigName
	} else {
		manifest["file"] = pack.FileName
		manifest["speakers"] = pack.Speakers
	}
	data, _ := json.Marshal(manifest)
	return append(data, '\n')
}

// publishFile подготавливает соседнюю копию до замены публичного имени.
// Ошибка копирования оставляет предыдущее содержимое целым.
func publishFile(from, target string) error {
	temporary := target + "." + voicecore.UUID() + ".tmp"
	defer os.Remove(temporary)
	if err := copyFile(from, temporary); err != nil {
		return err
	}
	return os.Rename(temporary, target)
}

// publishVenv меняет только собственную ссылку на прошедшую проверку generation.
// Отмена до rename оставляет прежнюю ссылку действующей.
func publishVenv(ctx context.Context, paths layout, runtime string) error {
	name, err := filepath.Rel(paths.engine, runtime)
	if err != nil {
		return err
	}
	candidate := paths.current + "." + voicecore.UUID() + ".tmp"
	defer os.Remove(candidate)
	if err := os.Symlink(name, candidate); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Rename(candidate, paths.current)
}
