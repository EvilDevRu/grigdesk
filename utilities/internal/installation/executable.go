package installation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

type Executable struct {
	file *os.File
	info os.FileInfo
	path string
}

// Executable проверяет точные байты и mode выбранного исполняемого файла той же генерации.
func (layout *Layout) Executable(componentPath, component, entry string) (*Executable, error) {
	manifest, err := layout.Manifest(componentPath, component)
	if err != nil {
		return nil, err
	}
	var expected *File
	for _, item := range manifest.Artifacts[component].Files {
		if item.Path == entry {
			expected = &item
			break
		}
	}
	if expected == nil || expected.Mode&0o111 == 0 {
		return nil, errors.New("release_executable_missing_from_inventory")
	}
	file, info, err := layout.openFile(componentPath + "/" + entry)
	if err != nil {
		return nil, errors.New("release_executable_invalid")
	}
	if info.Mode().Perm() != 0o555 || info.Size() != expected.Size || !checkHash(file, *expected) {
		_ = file.Close()
		return nil, errors.New("release_executable_hash_mismatch")
	}
	return &Executable{file: file, info: info, path: filepath.Join(layout.Receipt.Root, componentPath, entry)}, nil
}

func checkHash(file *os.File, expected File) bool {
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(file, expected.Size+1))
	return err == nil && count == expected.Size && hex.EncodeToString(hash.Sum(nil)) == expected.SHA256
}

func (layout *Layout) Maintenance() (*Executable, error) {
	const relative = "update/maintenance"
	var binding struct {
		Schema         int    `json:"schema"`
		InstallationID string `json:"installationId"`
		Size           int64  `json:"size"`
		SHA256         string `json:"sha256"`
	}
	data, err := layout.ReadPrivate(relative + ".json")
	if err != nil || !exactFields(data, "schema", "installationId", "size", "sha256") ||
		json.Unmarshal(data, &binding) != nil || binding.Schema != 1 ||
		binding.InstallationID != layout.Receipt.InstallationID || binding.Size <= 0 ||
		!sha256Text.MatchString(binding.SHA256) {
		return nil, errors.New("maintenance_binding_invalid")
	}
	binary, info, err := layout.openFile(relative)
	if err != nil || info.Mode().Perm()&0o100 == 0 || info.Size() != binding.Size ||
		!checkHash(binary, File{Size: binding.Size, SHA256: binding.SHA256}) {
		if binary != nil {
			_ = binary.Close()
		}
		return nil, errors.New("maintenance_executable_invalid")
	}
	return &Executable{file: binary, info: info, path: filepath.Join(layout.Receipt.Root, relative)}, nil
}

// Portable распознаёт готовую переносимую раскладку только рядом с физическим CLI.
func Portable(executable string) (string, bool) {
	actual, err := filepath.EvalSymlinks(executable)
	if err != nil || filepath.Base(filepath.Dir(actual)) != "bin" {
		return "", false
	}
	root := filepath.Dir(filepath.Dir(actual))
	physical, err := os.OpenRoot(root)
	if err != nil {
		return "", false
	}
	defer physical.Close()
	layout := Layout{root: physical}
	file, info, err := layout.openFile("bin/bundle.json")
	if err != nil {
		return "", false
	}
	defer file.Close()
	if info.Size() > 65536 {
		return "", false
	}
	var marker struct {
		Format int    `json:"format"`
		Kind   string `json:"kind"`
	}
	markerError := json.NewDecoder(io.LimitReader(file, 65537)).Decode(&marker)
	return root, markerError == nil && marker.Format == 1 && marker.Kind == "portable"
}

// ServerDirectory находит отдельно распакованный серверный комплект рядом с командой.
func ServerDirectory(executable string) (string, bool) {
	actual, err := filepath.EvalSymlinks(executable)
	if err != nil || filepath.Base(filepath.Dir(actual)) != "bin" {
		return "", false
	}
	root := filepath.Dir(filepath.Dir(actual))
	proof, err := ProveFile(filepath.Join(root, "release.json"))
	return root, err == nil && proof.Size > 0
}

func PortableExecutable(root, name string) (*Executable, error) {
	physical, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer physical.Close()
	layout := Layout{root: physical}
	relative := "bin/" + name
	file, info, err := layout.openFile(relative)
	if err != nil {
		return nil, errors.New("Проверенный файл компонента отсутствует.")
	}
	if info.Mode().Perm()&0o100 == 0 {
		_ = file.Close()
		return nil, errors.New("Файл компонента не исполняется.")
	}
	return &Executable{file: file, info: info, path: filepath.Join(root, relative)}, nil
}

func (executable *Executable) Close() error {
	return executable.file.Close()
}

// Exec заменяет процесс только что проверенным executable, сохраняя сигналы и потоки.
func (executable *Executable) Exec(argv, env []string) error {
	fd := executable.file.Fd()
	path, err := executable.execPath()
	if err != nil {
		return err
	}
	old, err := unix.FcntlInt(fd, unix.F_GETFD, 0)
	if err != nil {
		return err
	}
	if _, err := unix.FcntlInt(fd, unix.F_SETFD, old&^unix.FD_CLOEXEC); err != nil {
		return err
	}
	defer unix.FcntlInt(fd, unix.F_SETFD, old)
	return unix.Exec(path, append([]string{executable.path}, argv...), env)
}

func descriptorPath(fd uintptr) string {
	return "/proc/self/fd/" + strconv.FormatUint(uint64(fd), 10)
}

// Environment закрепляет runtime data за квитанцией. Предпочтения процесса установки не наследуются.
func (receipt Receipt) Environment(env map[string]string) map[string]string {
	checked := make(map[string]string, len(env))
	for key, value := range env {
		switch key {
		case "APPIMAGE", "APPDIR", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "GRIGDESK_CTL_CHECKOUT_ROOT":
		default:
			checked[key] = value
		}
	}
	checked["GRIGDESK_HOME"] = receipt.DataHome
	checked["GRIGDESK_ENV_FILE"] = filepath.Join(receipt.DataHome, ".env")
	checked["GRIGDESK_DESKTOP_DATA_DIR"] = receipt.UserData
	return checked
}

func Environ(env map[string]string) []string {
	result := make([]string, 0, len(env))
	for key, value := range env {
		if !strings.ContainsAny(key, "=\x00") {
			result = append(result, key+"="+value)
		}
	}
	return result
}
