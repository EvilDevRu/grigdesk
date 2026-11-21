package install

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/internal/installation"
)

var ErrUpdateRequiresCurrent = errors.New("release_update_requires_current_owner")

type Options struct {
	Root       string `json:"root"`
	DataHome   string `json:"dataHome"`
	UserData   string `json:"userData"`
	BinDir     string `json:"binDir"`
	AppsDir    string `json:"appsDir"`
	UnitDir    string `json:"unitDir"`
	Mode       string `json:"mode"`
	Descriptor string `json:"descriptor"`
	Index      string `json:"-"`
	Source     string `json:"-"`
	Cache      string `json:"-"`
	Migrate    bool   `json:"-"`
	Expected   string `json:"-"`
}

type publication struct {
	Path  string `json:"path"`
	Bytes []byte `json:"bytes"`
	Mode  uint32 `json:"mode"`
}

type preparation struct {
	Schema    int                               `json:"schema"`
	UID       int                               `json:"uid"`
	Options   Options                           `json:"options"`
	Receipt   installation.Receipt              `json:"receipt"`
	Pointer   installation.Pointer              `json:"pointer"`
	Digest    string                            `json:"manifestDigest"`
	ReleaseID string                            `json:"releaseId"`
	Stage     string                            `json:"stage"`
	StageID   installation.Identity             `json:"stageIdentity"`
	ParentID  installation.Identity             `json:"parentIdentity"`
	Files     map[string]installation.FileProof `json:"files"`
	Outputs   []publication                     `json:"outputs"`
}

type selectedRelease struct {
	Manifest installation.Manifest
	Envelope []byte
}

// ParseOptions принимает закрытый argv bootstrap до чтения или создания файлов.
func ParseOptions(argv []string) (Options, error) {
	var options Options
	fields := map[string]*string{
		"--root": &options.Root, "--data-home": &options.DataHome, "--user-data": &options.UserData,
		"--release": &options.Index, "--source-dir": &options.Source, "--cache-dir": &options.Cache,
		"--mode": &options.Mode, "--bin-dir": &options.BinDir, "--applications-dir": &options.AppsDir,
		"--unit-dir": &options.UnitDir, "--expected-current-sha": &options.Expected,
	}
	seen := make(map[string]bool)
	for len(argv) > 0 {
		flag := argv[0]
		if seen[flag] {
			return Options{}, errors.New("installation_arguments_repeated")
		}
		seen[flag] = true
		if flag == "--migrate-to-go" {
			options.Migrate = true
			argv = argv[1:]
			continue
		}
		field, ok := fields[flag]
		if !ok || len(argv) < 2 || argv[1] == "" || strings.HasPrefix(argv[1], "--") {
			return Options{}, errors.New("installation_arguments_invalid")
		}
		*field = argv[1]
		argv = argv[2:]
	}
	if options.Migrate != (options.Expected != "") ||
		options.Migrate && !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(options.Expected) {
		return Options{}, errors.New("release_cutover_consent_mismatch")
	}
	if !slices.Contains([]string{"local", "server", "remote"}, options.Mode) {
		return Options{}, errors.New("installation_mode_invalid")
	}
	for _, path := range []string{options.Root, options.DataHome, options.UserData, options.BinDir,
		options.AppsDir, options.UnitDir, options.Index} {
		if !validPath(path) {
			return Options{}, errors.New("installation_input_invalid")
		}
	}
	for _, path := range []string{options.Cache, options.Source} {
		if path != "" && !validPath(path) {
			return Options{}, errors.New("installation_input_invalid")
		}
	}
	for _, separate := range []string{options.DataHome, options.UserData, options.BinDir, options.AppsDir, options.UnitDir} {
		if separate == options.Root || strings.HasPrefix(separate, options.Root+"/") {
			return Options{}, errors.New("installation_input_invalid")
		}
	}
	if options.Mode == "local" {
		data := os.Getenv("XDG_DATA_HOME")
		if data == "" {
			home, _ := os.UserHomeDir()
			data = filepath.Join(home, ".local", "share")
			if runtime.GOOS == "darwin" {
				data = filepath.Join(home, "Library", "Application Support")
			}
		}
		options.Descriptor = filepath.Join(data, "grigdesk", "desktop", "runtime.json")
		if !validPath(options.Descriptor) {
			return Options{}, errors.New("installation_input_invalid")
		}
	}
	return options, nil
}

func validPath(path string) bool {
	return filepath.IsAbs(path) && path != "/" && filepath.Clean(path) == path &&
		!strings.ContainsAny(path, "\x00\n\r\t\x7f\"'`$\\%")
}

// ReadRelease проверяет кандидат целиком до любых системных действий.
func ReadRelease(index string) (installation.Manifest, []byte, error) {
	data, err := installation.ReadOrdinary(index, 1<<20)
	if err != nil {
		return installation.Manifest{}, nil, err
	}
	return installation.SignedIndex(data)
}

// Run ставит подписанный v3 в чистый корень либо продолжает ранее начатую публикацию.
func Run(ctx context.Context, options Options) error {
	manifest, envelope, err := ReadRelease(options.Index)
	if err != nil {
		return err
	}
	if manifest.Format != 3 {
		return errors.New("release_go_target_required")
	}
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH]
	if manifest.Platform.OS != runtime.GOOS || manifest.Platform.Arch != arch {
		return errors.New("release_platform_incompatible")
	}
	for _, dir := range []string{options.Root, options.DataHome, options.UserData, options.BinDir,
		options.AppsDir, options.UnitDir} {
		if err := installation.CheckParents(dir); err != nil {
			return err
		}
	}
	parent := filepath.Dir(options.Root)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	lock, err := installation.AcquireLock(options.Root + ".install-lock")
	if err != nil {
		return err
	}
	defer lock()
	release := selectedRelease{Manifest: manifest, Envelope: envelope}
	intent := options.Root + ".installing.json"
	pending, err := loadIntent(intent, options, release)
	if err == nil {
		return publish(ctx, pending, intent)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if _, err := os.Lstat(options.Root); err == nil {
		return handleExisting(ctx, options, release)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if options.Migrate {
		return errors.New("release_cutover_source_invalid")
	}
	if err := checkExternal(options); err != nil {
		return err
	}
	prepared, err := prepare(ctx, options, release, intent)
	if err != nil {
		return err
	}
	return publish(ctx, prepared, intent)
}

func loadIntent(path string, options Options, release selectedRelease) (preparation, error) {
	if _, err := os.Lstat(path); err != nil {
		return preparation{}, err
	}
	proof, err := installation.ProveFile(path)
	if err != nil || proof.Mode != 0o600 {
		return preparation{}, errors.New("installation_intent_invalid")
	}
	content, err := installation.ReadOrdinary(path, 1<<20)
	if err != nil {
		return preparation{}, err
	}
	var saved preparation
	if json.Unmarshal(content, &saved) != nil || saved.Schema != 1 || saved.UID != os.Getuid() ||
		saved.Digest != release.Manifest.Digest || saved.ReleaseID != release.Manifest.ReleaseID ||
		saved.Options != boundOptions(options) || saved.Receipt.Root != options.Root ||
		saved.Pointer.InstallationID != saved.Receipt.InstallationID ||
		!samePointer(saved.Pointer, newPointer(saved.Receipt, release.Manifest.Version)) ||
		saved.Receipt.DataHome != options.DataHome || saved.Receipt.UserData != options.UserData ||
		saved.Receipt.Mode != options.Mode || saved.Receipt.UID != os.Getuid() ||
		filepath.Dir(saved.Stage) != filepath.Dir(options.Root) ||
		!strings.HasPrefix(filepath.Base(saved.Stage), stageName(options.Root)) {
		return preparation{}, errors.New("installation_intent_conflict")
	}
	if !slices.EqualFunc(saved.Outputs, publications(saved.Options, saved.Receipt, saved.Pointer),
		func(a, b publication) bool {
			return a.Path == b.Path && a.Mode == b.Mode && string(a.Bytes) == string(b.Bytes)
		}) {
		return preparation{}, errors.New("installation_intent_invalid")
	}
	return saved, nil
}

func boundOptions(options Options) Options {
	options.Index = ""
	options.Source = ""
	options.Cache = ""
	options.Expected = ""
	options.Migrate = false
	return options
}

func handleExisting(ctx context.Context, options Options, release selectedRelease) error {
	layout, err := installation.Open(options.Root)
	if err != nil {
		return errors.New("installation_root_conflict")
	}
	defer layout.Close()
	receipt := layout.Receipt
	if receipt.Mode != options.Mode || receipt.DataHome != options.DataHome || receipt.UserData != options.UserData {
		return errors.New("installation_root_conflict")
	}
	active, pointerErr := layout.Current()
	cutover, err := readCutover(layout)
	migrated := err == nil
	switch {
	case err == nil:
		if cutover.Stage != "generation_active" || options.Migrate ||
			pointerErr != nil || active.Format != 2 {
			return migration(ctx, layout, options, release)
		}
		if installation.CompareVersions(active.Floor, cutover.TargetVersion) < 0 {
			return errors.New("release_cutover_identity_mismatch")
		}
		if err := bindMigrationHelper(receipt.Root, cutover); err != nil {
			return err
		}
		if samePointer(active, cutover.TargetCurrent) && release.Manifest.Digest == cutover.TargetDigest {
			return migration(ctx, layout, options, release)
		}
	case !errors.Is(err, os.ErrNotExist):
		return err
	case pointerErr != nil:
		return pointerErr
	case active.Format == 1:
		return migration(ctx, layout, options, release)
	case options.Migrate:
		return errors.New("release_cutover_source_invalid")
	}
	current, err := layout.Manifest(*active.Control, "control")
	if err != nil {
		return err
	}
	if current.Digest != release.Manifest.Digest {
		return ErrUpdateRequiresCurrent
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	for _, component := range []string{"control", "server", "desktop"} {
		generation := map[string]*string{"control": active.Control, "server": active.Server, "desktop": active.Desktop}[component]
		if generation == nil {
			continue
		}
		manifest, err := layout.Manifest(*generation, component)
		if err != nil || manifest.Digest != release.Manifest.Digest {
			return errors.New("installation_current_release_changed")
		}
		if err := checkComponent(receipt.Root, *generation, manifest.Artifacts[component]); err != nil {
			return err
		}
	}
	helper, err := layout.Maintenance()
	if err != nil {
		return err
	}
	defer helper.Close()
	if migrated {
		// Переход сохраняет внешнюю регистрацию владельца прежней установки.
		// Повтор проверяет активный выпуск и helper без замены ярлыков и службы.
		return nil
	}
	for _, target := range publications(boundOptions(options), receipt, active) {
		proof, err := installation.ProveFile(target.Path)
		if err != nil || proof.SHA256 != installation.Hash(target.Bytes) || proof.Mode != target.Mode {
			return errors.New("installation_registration_changed")
		}
	}
	return nil
}

func stageName(root string) string {
	return "." + filepath.Base(root) + ".install-"
}

func checkComponent(root, relative string, artifact installation.Artifact) error {
	for _, item := range artifact.Files {
		mode := uint32(0o444)
		if item.Mode&0o111 != 0 {
			mode = 0o555
		}
		proof, err := installation.ProveFile(filepath.Join(root, relative, item.Path))
		if err != nil || proof.Size != item.Size || proof.SHA256 != item.SHA256 || proof.Mode != mode {
			return errors.New("release_file_hash_mismatch")
		}
	}
	return nil
}

func copyHelper(dest string) (installation.FileProof, error) {
	name, err := os.Executable()
	if err != nil {
		return installation.FileProof{}, err
	}
	input, err := os.Open(name)
	if err != nil {
		return installation.FileProof{}, err
	}
	defer input.Close()
	file, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		return installation.FileProof{}, err
	}
	_, copied := io.Copy(file, input)
	synced := file.Sync()
	closed := file.Close()
	if err := errors.Join(copied, synced, closed); err != nil {
		return installation.FileProof{}, err
	}
	return installation.ProveFile(dest)
}
