package runner

import (
	"encoding/json"
	"encoding/json/jsontext"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
)

type externalCLI struct {
	Bin, Identity, ProviderID, ResourceKey, LeaseDirectory string
	LeaseCommand                                           []string
	Env                                                    map[string]string
}

var externalDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var externalEnvName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// readExternalCLI принимает только частный descriptor хоста и закрепляет одну
// физическую копию. Без записи своего провайдера работает локальный выбор CLI.
func readExternalCLI(file, provider string) (*externalCLI, error) {
	if file == "" || !slices.Contains([]string{"claude", "codex", "kimi", "qwen"}, provider) {
		return nil, nil
	}
	physical, err := filepath.EvalSymlinks(file)
	if err != nil || !filepath.IsAbs(file) || physical != file {
		return nil, fmt.Errorf("descriptor внешнего CLI должен быть физическим файлом")
	}
	f, err := os.OpenFile(file, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("не удалось открыть descriptor внешнего CLI")
	}
	defer f.Close()
	info, err := f.Stat()
	stat, ok := fileOwner(info)
	if err != nil || !ok || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 ||
		stat != uint32(os.Getuid()) {
		return nil, fmt.Errorf("нужен частный descriptor внешнего CLI")
	}
	const limit = 1024 * 1024
	raw, err := io.ReadAll(io.LimitReader(f, limit+1))
	var document struct {
		SchemaVersion int
		Providers     map[string]*externalCLI
	}
	if err != nil || len(raw) > limit || !jsontext.Value(raw).IsValid() ||
		json.Unmarshal(raw, &document) != nil || document.SchemaVersion != 1 {
		return nil, fmt.Errorf("неверный descriptor внешнего CLI")
	}
	entry := document.Providers[provider]
	if entry != nil && !entry.valid(provider) {
		return nil, fmt.Errorf("неверная identity выбранного CLI %s", provider)
	}
	return entry, nil
}

func fileOwner(info os.FileInfo) (uint32, bool) {
	if info == nil {
		return 0, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 {
		return 0, false
	}
	return stat.Uid, true
}

func (entry *externalCLI) valid(provider string) bool {
	return entry.ProviderID == provider && externalDigest.MatchString(entry.Identity) &&
		externalDigest.MatchString(entry.ResourceKey) && filepath.IsAbs(entry.LeaseDirectory) &&
		filepath.Clean(entry.LeaseDirectory) == entry.LeaseDirectory &&
		filepath.IsAbs(entry.Bin) && len(entry.LeaseCommand) > 0 && filepath.IsAbs(entry.LeaseCommand[0])
}

// withEnvironment добавляет переданную хостом среду выбранной копии и профиля.
// Capability и loader controls выдаёт только доверенный Go-хост.
func (entry *externalCLI) withEnvironment(env []string) []string {
	if entry == nil {
		return env
	}
	result := slices.Clone(env)
	for name, value := range entry.Env {
		if externalEnvName.MatchString(name) && !strings.ContainsRune(value, 0) &&
			!strings.HasPrefix(name, "FACTORY_") && !strings.HasPrefix(name, "LD_") &&
			!strings.HasPrefix(name, "DYLD_") && !slices.Contains(
			[]string{"BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "HOME", "SHELL"}, name) {
			result = append(result, name+"="+value)
		}
	}
	return result
}

// command помещает lease перед точным CLI и сохраняет argv без shell-оценки.
// Qwen использует тот же lease API через Node wrapper своего адаптера.
func (entry *externalCLI) command(path string, args []string) (string, []string) {
	if entry == nil || path != entry.Bin {
		return path, args
	}
	prefix := append(slices.Clone(entry.LeaseCommand[1:]),
		"--identity", entry.Identity, "--lease-dir", entry.LeaseDirectory,
		"--provider", entry.ProviderID, "--resource", entry.ResourceKey, "--", path)
	return entry.LeaseCommand[0], append(prefix, args...)
}
