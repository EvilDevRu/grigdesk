package installation

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

type Receipt struct {
	Format         int    `json:"format"`
	InstallationID string `json:"installationId"`
	UID            int    `json:"uid"`
	Root           string `json:"root"`
	Mode           string `json:"mode"`
	Channel        string `json:"channel"`
	DataHome       string `json:"dataHome"`
	UserData       string `json:"userData"`
	Source         string `json:"source,omitempty"`
	TrustKeySHA256 string `json:"trustKeySha256,omitempty"`
}

type Pointer struct {
	Format         int     `json:"format"`
	InstallationID string  `json:"installationId"`
	Desktop        *string `json:"desktop"`
	Server         *string `json:"server"`
	Control        *string `json:"control,omitempty"`
	Floor          string  `json:"floor,omitempty"`
}

type Layout struct {
	Receipt Receipt
	root    *os.Root
}

var (
	productVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-dev\.(0|[1-9][0-9]*))?$`)
	installationID = regexp.MustCompile(`^[0-9a-f-]{36}$`)
	sha256Text     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func ValidVersion(version string) bool {
	parts := productVersion.FindStringSubmatch(version)
	if parts == nil {
		return false
	}
	for _, text := range parts[1:] {
		if text != "" {
			if _, err := strconv.ParseUint(text, 10, 53); err != nil {
				return false
			}
		}
	}
	return true
}

// Candidate связывает режим с физическим именем CLI до рассмотрения пути checkout.
func Candidate(executable string) (string, error) {
	physical, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", err
	}
	parts := strings.Split(physical, "/")
	if count := len(parts); count >= 5 && parts[count-4] == "generations" &&
		ValidVersion(parts[count-3]) &&
		parts[count-2] == "bin" && parts[count-1] == "grigdesk-ctl" {
		return strings.Join(parts[:count-4], "/"), nil
	}
	parent := filepath.Dir(physical)
	if filepath.Base(physical) != "grigdesk-ctl" ||
		(filepath.Base(parent) != "bin" && filepath.Base(parent) != "launchers") {
		return "", nil
	}
	root := filepath.Dir(parent)
	_, err = os.Lstat(filepath.Join(root, "installation.json"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return root, err
}

func safeAbsolute(value string) bool {
	return filepath.IsAbs(value) && value != "/" && filepath.Clean(value) == value &&
		!strings.ContainsRune(value, 0)
}

func owned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Getuid() && info.Mode().Perm()&0o022 == 0
}

// Open проверяет физическое дерево и загружает приватную квитанцию одного владельца.
func Open(name string) (*Layout, error) {
	if !safeAbsolute(name) {
		return nil, errors.New("installation_root_invalid")
	}
	physical, err := filepath.EvalSymlinks(name)
	if err != nil || physical != name {
		return nil, errors.New("installation_root_invalid")
	}
	original, err := os.Lstat(name)
	if err != nil || !original.IsDir() || !owned(original) {
		return nil, errors.New("installation_root_invalid")
	}
	root, err := os.OpenRoot(name)
	if err != nil {
		return nil, errors.New("installation_root_invalid")
	}
	openInfo, err := root.Stat(".")
	if err != nil || !os.SameFile(openInfo, original) {
		_ = root.Close()
		return nil, errors.New("installation_root_invalid")
	}
	layout := &Layout{root: root}
	content, err := layout.ReadPrivate("installation.json")
	if err != nil {
		_ = root.Close()
		return nil, err
	}
	if err := decodeReceipt(content, name, &layout.Receipt); err != nil {
		_ = root.Close()
		return nil, err
	}
	return layout, nil
}

func (layout *Layout) Close() error {
	return layout.root.Close()
}

func decodeReceipt(content []byte, root string, receipt *Receipt) error {
	if err := json.Unmarshal(content, receipt); err != nil {
		return errors.New("installation_receipt_invalid")
	}
	fields := []string{"format", "installationId", "uid", "root", "mode", "channel", "dataHome", "userData"}
	switch receipt.Format {
	case 1:
	case 2:
		fields = append(fields, "source", "trustKeySha256")
		if (receipt.Source != "candidate-file" && receipt.Source != "local-test") ||
			!sha256Text.MatchString(receipt.TrustKeySHA256) {
			return errors.New("installation_receipt_invalid")
		}
	default:
		return errors.New("installation_receipt_invalid")
	}
	if !exactFields(content, fields...) || receipt.UID != os.Getuid() || receipt.Root != root ||
		!installationID.MatchString(receipt.InstallationID) ||
		(receipt.Mode != "local" && receipt.Mode != "server" && receipt.Mode != "remote") ||
		(receipt.Channel != "release" && receipt.Channel != "dev") {
		return errors.New("installation_receipt_invalid")
	}
	for _, directory := range []string{receipt.DataHome, receipt.UserData} {
		if !safeAbsolute(directory) || directory == root || strings.HasPrefix(directory, root+"/") {
			return errors.New("installation_receipt_invalid")
		}
	}
	return nil
}

func exactFields(data []byte, fields ...string) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil || len(object) != len(fields) {
		return false
	}
	for _, field := range fields {
		if object[field] == nil {
			return false
		}
	}
	return true
}

func validRelative(value string) bool {
	return value != "" && !filepath.IsAbs(value) && filepath.Clean(value) == value &&
		value != "." && value != ".." && !strings.HasPrefix(value, "../") &&
		!strings.ContainsAny(value, "\\\x00")
}

// openFile раскрывает каждый сегмент внутри физического корня и связывает проверку с fd.
func (layout *Layout) openFile(relative string) (*os.File, os.FileInfo, error) {
	if !validRelative(relative) {
		return nil, nil, errors.New("installation_path_invalid")
	}
	parts := strings.Split(relative, "/")
	parent := layout.root
	var roots []*os.Root
	defer func() {
		for _, child := range roots {
			_ = child.Close()
		}
	}()
	for _, name := range parts[:len(parts)-1] {
		observed, err := parent.Lstat(name)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, err
		}
		if err != nil || !observed.IsDir() || !owned(observed) {
			return nil, nil, errors.New("installation_path_invalid")
		}
		next, err := parent.OpenRoot(name)
		if err != nil {
			return nil, nil, errors.New("installation_path_invalid")
		}
		roots = append(roots, next)
		actual, err := next.Stat(".")
		if err != nil || !owned(actual) || !os.SameFile(actual, observed) {
			return nil, nil, errors.New("installation_owner_invalid")
		}
		parent = next
	}
	name := parts[len(parts)-1]
	file, err := parent.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !owned(info) {
		_ = file.Close()
		return nil, nil, errors.New("installation_owner_invalid")
	}
	return file, info, nil
}

// ReadPrivate не принимает файл по ссылке, с чужим UID или с общими правами.
func (layout *Layout) ReadPrivate(relative string) ([]byte, error) {
	file, info, err := layout.openFile(relative)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	const limit = 1 << 20
	if info.Mode().Perm()&0o077 != 0 || info.Size() > limit {
		return nil, errors.New("installation_state_invalid")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || len(data) > limit {
		return nil, errors.New("installation_state_invalid")
	}
	return data, nil
}

// Current читает одну ревизию, не выбирая отдельные компоненты по PATH.
func (layout *Layout) Current() (Pointer, error) {
	data, err := layout.ReadPrivate("current.json")
	if err != nil {
		return Pointer{}, err
	}
	var pointer Pointer
	if json.Unmarshal(data, &pointer) != nil || pointer.InstallationID != layout.Receipt.InstallationID {
		return Pointer{}, errors.New("installation_pointer_invalid")
	}
	fields := []string{"format", "installationId", "desktop", "server"}
	switch pointer.Format {
	case 1:
	case 2:
		fields = append(fields, "control", "floor")
		if pointer.Control == nil || !ValidVersion(pointer.Floor) {
			return Pointer{}, errors.New("installation_pointer_invalid")
		}
		parts := strings.Split(*pointer.Control, "/")
		if len(parts) != 2 || parts[0] != "generations" || !ValidVersion(parts[1]) ||
			CompareVersions(parts[1], pointer.Floor) < 0 {
			return Pointer{}, errors.New("installation_pointer_invalid")
		}
		if err := layout.verifyDirectory(*pointer.Control + "/bin"); err != nil {
			return Pointer{}, err
		}
	default:
		return Pointer{}, errors.New("installation_pointer_invalid")
	}
	if !exactFields(data, fields...) {
		return Pointer{}, errors.New("installation_pointer_invalid")
	}
	for _, component := range []struct {
		name     string
		relative *string
		required bool
	}{
		{"desktop", pointer.Desktop, layout.Receipt.Mode != "server"},
		{"server", pointer.Server, layout.Receipt.Mode != "remote"},
	} {
		if component.relative == nil {
			if component.required {
				return Pointer{}, errors.New("installation_component_missing")
			}
			continue
		}
		parts := strings.Split(*component.relative, "/")
		if len(parts) != 3 || parts[0] != "generations" || !ValidVersion(parts[1]) ||
			parts[2] != component.name || !component.required ||
			pointer.Format == 2 && CompareVersions(parts[1], pointer.Floor) < 0 {
			return Pointer{}, errors.New("installation_pointer_invalid")
		}
		if err := layout.verifyDirectory(*component.relative); err != nil {
			return Pointer{}, err
		}
	}
	return pointer, nil
}

func (layout *Layout) verifyDirectory(relative string) error {
	if !validRelative(relative) {
		return errors.New("installation_path_invalid")
	}
	prefix := ""
	for _, segment := range strings.Split(relative, "/") {
		prefix = filepath.Join(prefix, segment)
		info, err := layout.root.Lstat(prefix)
		if err != nil || !info.IsDir() || !owned(info) {
			return fmt.Errorf("installation_path_invalid: %s", segment)
		}
	}
	return nil
}

func (pointer Pointer) Version() string {
	for _, current := range []*string{pointer.Control, pointer.Desktop, pointer.Server} {
		if current != nil {
			return strings.Split(*current, "/")[1]
		}
	}
	return ""
}
