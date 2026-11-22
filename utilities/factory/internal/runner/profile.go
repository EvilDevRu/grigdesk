package runner

import (
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

var (
	profileKey = regexp.MustCompile(
		`^(RUNNERS_(SCHEMA|COVERAGE)|CONFIG_REVISION|PROJECT_RUNNER_(PRIMARY|FAILOVER)|` +
			`STAGE_[A-Z0-9_]*_(PRIMARY|FAILOVER)|MODEL_[A-Z0-9_]*|RUNNER_[A-Z0-9_]*_AUTH_PROFILE)$`)
	profileValue       = regexp.MustCompile(`^[A-Za-z0-9._,:/@=+-]*$`)
	revisionPattern    = regexp.MustCompile(`^[0-9]+$`)
	ProviderName       = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
	providerChain      = regexp.MustCompile(`^[a-z][a-z0-9_-]*(,[a-z][a-z0-9_-]*)*$`)
	ErrProfileConflict = errors.New("настройки исполнителя изменились")
	ErrInvalidProfile  = errors.New("требуется canonical runners.env")
)

type ProfileConfig struct {
	lines  []string
	Values map[string]string
}

// ReadProfile читает значения как данные. Дубликаты и произвольный shell
// несовместимы с общим Bash/Go контрактом.
func ReadProfile(path string) (ProfileConfig, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return ProfileConfig{}, err
	}
	physical, err := filepath.EvalSymlinks(path)
	if err != nil || physical != path || !info.Mode().IsRegular() {
		return ProfileConfig{}, ErrInvalidProfile
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ProfileConfig{}, err
	}
	p := ProfileConfig{
		lines:  strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n"),
		Values: make(map[string]string),
	}
	for _, line := range p.lines {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if _, seen := p.Values[key]; !ok || seen || !profileKey.MatchString(key) ||
			!profileValue.MatchString(value) {
			return ProfileConfig{}, ErrInvalidProfile
		}
		p.Values[key] = value
	}
	if !validProfile(p.Values) {
		return ProfileConfig{}, ErrInvalidProfile
	}
	return p, nil
}

func validProfile(values map[string]string) bool {
	return values["RUNNERS_SCHEMA"] == "1" && revisionPattern.MatchString(values["CONFIG_REVISION"]) &&
		ProviderName.MatchString(values["PROJECT_RUNNER_PRIMARY"]) &&
		ValidChain(values["PROJECT_RUNNER_FAILOVER"])
}

func ValidChain(s string) bool {
	return s == "" || providerChain.MatchString(s)
}

func ProviderKey(s string) string {
	return strings.ReplaceAll(strings.ToUpper(s), "-", "_")
}

// UpdateProfile под той же блокировкой сравнивает строку ревизии и сохраняет
// комментарии и порядок ключей. Версии старого CLI понимают получившиеся байты.
func UpdateProfile(path, revision string, updates map[string]string, create bool) error {
	file, err := host.OpenPath(path+".lock", os.O_CREATE|os.O_RDWR, 0600, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	for tries := 0; ; tries++ {
		err = host.TryProcessLock(file)
		if !errors.Is(err, syscall.EWOULDBLOCK) || tries == 100 {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	profile, err := ReadProfile(path)
	switch {
	case create && errors.Is(err, fs.ErrNotExist):
		profile.Values = map[string]string{"RUNNERS_SCHEMA": "1", "CONFIG_REVISION": "0"}
	case err == nil && create:
		return ErrProfileConflict
	case err != nil:
		return err
	}
	if profile.Values["CONFIG_REVISION"] != revision {
		return ErrProfileConflict
	}
	n, err := strconv.ParseUint(revision, 10, 63)
	if err != nil || n == 1<<63-1 {
		return ErrInvalidProfile
	}
	for k, v := range updates {
		if k == "RUNNERS_SCHEMA" || k == "CONFIG_REVISION" ||
			!profileKey.MatchString(k) || !profileValue.MatchString(v) {
			return ErrInvalidProfile
		}
		profile.Values[k] = v
	}
	profile.Values["CONFIG_REVISION"] = strconv.FormatUint(n+1, 10)
	if !validProfile(profile.Values) {
		return ErrInvalidProfile
	}
	return saveProfile(path, profile)
}

func saveProfile(path string, profile ProfileConfig) error {
	var content strings.Builder
	for _, line := range profile.lines {
		if line == "" || strings.HasPrefix(line, "#") {
			fmt.Fprintln(&content, line)
		} else {
			key, _, _ := strings.Cut(line, "=")
			fmt.Fprintf(&content, "%s=%s\n", key, profile.Values[key])
			delete(profile.Values, key)
		}
	}
	for _, key := range slices.Sorted(maps.Keys(profile.Values)) {
		fmt.Fprintf(&content, "%s=%s\n", key, profile.Values[key])
	}
	parent := filepath.Dir(path)
	temp, err := os.CreateTemp(parent, ".runners.*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	if _, err := temp.WriteString(content.String()); err != nil {
		return err
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp.Name(), path); err != nil {
		return err
	}
	dir, err := os.Open(parent)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
