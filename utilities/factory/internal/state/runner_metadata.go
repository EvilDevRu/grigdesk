package state

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

const stageMetadataFile = "runner-metadata.json"
const stageMetadataLimit = 64 * 1024

// StageMetadataScope закрепляет копии CLI и узкое окружение каталога моделей попытки.
// Запись не содержит токенов и содержимого профилей доступа.
type StageMetadataScope struct {
	Schema              int                         `json:"schema"`
	Task                string                      `json:"task"`
	Profile             string                      `json:"profile"`
	Attempt             string                      `json:"attempt"`
	Checkout            string                      `json:"checkout,omitempty"`
	Providers           map[string]StageMetadataCLI `json:"providers"`
	MetadataEnvironment map[string]string           `json:"metadataEnvironment"`
}

// StageMetadataCLI описывает физическую копию CLI без секретов.
// Внешняя копия дополнительно несёт identity и параметры lease.
type StageMetadataCLI struct {
	Executable          string            `json:"executable"`
	Digest              string            `json:"digest"`
	Identity            string            `json:"identity,omitempty"`
	ResourceKey         string            `json:"resourceKey,omitempty"`
	LeaseDirectory      string            `json:"leaseDirectory,omitempty"`
	LeaseCommand        []string          `json:"leaseCommand,omitempty"`
	MetadataEnvironment map[string]string `json:"metadataEnvironment,omitempty"`
}

// Fingerprint связывает подтверждённые копии CLI с ревизией каталога.
// Пустая или отсутствующая запись даёт прежний отпечаток отсутствия.
func (scope *StageMetadataScope) Fingerprint() string {
	if scope == nil || len(scope.Providers) == 0 {
		return ""
	}
	entries := make([][4]string, 0, len(scope.Providers))
	for _, provider := range slices.Sorted(maps.Keys(scope.Providers)) {
		entry := scope.Providers[provider]
		entries = append(entries, [4]string{provider, entry.Identity, entry.ResourceKey, entry.Digest})
	}
	wire, _ := json.Marshal(entries)
	hash := sha256.Sum256(wire)
	return hex.EncodeToString(hash[:])
}

// ValidExternal сверяет поля внешней копии с контрактом runner.externalCLI.valid.
// Проверка файла и digest выполняется отдельно для внешних и локальных копий.
func (entry StageMetadataCLI) ValidExternal() bool {
	return digestPattern.MatchString(entry.Identity) && digestPattern.MatchString(entry.ResourceKey) &&
		filepath.IsAbs(entry.LeaseDirectory) && filepath.Clean(entry.LeaseDirectory) == entry.LeaseDirectory &&
		filepath.IsAbs(entry.Executable) && len(entry.LeaseCommand) > 0 && filepath.IsAbs(entry.LeaseCommand[0])
}

func (entry StageMetadataCLI) local() bool {
	return entry.Identity == "" && entry.ResourceKey == "" &&
		entry.LeaseDirectory == "" && len(entry.LeaseCommand) == 0
}

// StageMetadataExecutableDigest читает физический исполняемый файл того же владельца.
// Снимок недействителен, если файл исчез, заменился или изменился во время чтения.
func StageMetadataExecutableDigest(name string) (string, error) {
	real, err := filepath.EvalSymlinks(name)
	if err != nil || !filepath.IsAbs(name) || real != name {
		return "", fmt.Errorf("неподтверждённый файл metadata CLI")
	}
	file, err := host.OpenPath(name, os.O_RDONLY, 0, host.Nonblocking)
	if err != nil {
		return "", err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || !host.RealFileOwner(file, before) {
		return "", fmt.Errorf("неподтверждённый владелец metadata CLI")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	after, err := file.Stat()
	if err != nil {
		return "", err
	}
	selected, err := os.Lstat(name)
	if err != nil || !os.SameFile(before, selected) || before.Size() != after.Size() ||
		before.ModTime() != after.ModTime() {
		return "", fmt.Errorf("файл metadata CLI изменился")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// validMetadataEnvironment сверяет узкий снимок с системным списком runner.
// Остальные переменные могут принадлежать нативному запуску и не идут в каталог.
func validMetadataEnvironment(environment map[string]string) bool {
	for key, value := range environment {
		if strings.ContainsRune(value, 0) {
			return false
		}
		if key == "GRIGDESK_HOME" || key == "CODEX_HOME" || key == "CLAUDE_CONFIG_DIR" {
			continue
		}
		if runtime.GOOS == "windows" {
			key = strings.ToUpper(key)
			switch key {
			case "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
				"TEMP", "TMP", "PATHEXT", "COMSPEC":
				continue
			}
		}
		switch key {
		case "PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR", "FACTORY_HOME", "FACTORY_FORBID_LIVE",
			"XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "GRIGDESK_RUNTIME_ROOT",
			"FACTORY_DARWIN_PROCESS_HELPER", "FACTORY_DARWIN_PROCESS_HELPER_SHA256":
		default:
			return false
		}
	}
	return true
}

// validEnvironment защищает общий снимок и переопределения отдельных CLI.
// Неизвестный ключ в любом из них делает запись недоверенной целиком.
func (scope StageMetadataScope) validEnvironment() bool {
	if !validMetadataEnvironment(scope.MetadataEnvironment) {
		return false
	}
	for _, entry := range scope.Providers {
		if !validMetadataEnvironment(entry.MetadataEnvironment) {
			return false
		}
	}
	return true
}

// WriteStageMetadataScope меняет один доверенный снимок под блокировкой задачи.
// Пустая карта провайдеров публикует явное состояние недоступности.
func (s Store) WriteStageMetadataScope(attempt Attempt, scope StageMetadataScope) error {
	if !attemptPattern.MatchString(attempt.ID) || !profilePattern.MatchString(attempt.Profile) {
		return ErrConflict
	}
	task, err := s.openTask(attempt.Task, true)
	if err != nil {
		return err
	}
	defer task.close()
	active, err := task.activeAttempt(attempt.Task)
	if err != nil || active != attempt.ID {
		return ErrConflict
	}
	return task.writeStageMetadataScope(attempt, scope)
}

// writeStageMetadataScope сериализует точную попытку до atomic replace.
// Вызывающий уже владеет блокировкой и проверил активный указатель.
func (t *taskState) writeStageMetadataScope(attempt Attempt, scope StageMetadataScope) error {
	scope.Schema, scope.Task, scope.Profile, scope.Attempt = 1, attempt.Task, attempt.Profile, attempt.ID
	if scope.Providers == nil {
		scope.Providers = map[string]StageMetadataCLI{}
	}
	if scope.MetadataEnvironment == nil {
		scope.MetadataEnvironment = map[string]string{}
	}
	if !scope.validEnvironment() {
		return fmt.Errorf("неверное окружение metadata CLI")
	}
	raw, err := json.Marshal(scope)
	if err != nil || len(raw) > stageMetadataLimit {
		return fmt.Errorf("неверный размер записи metadata CLI")
	}
	dir := filepath.Join("attempts", attempt.ID)
	if err := ensurePrivateDirectory(t.root, dir, false); err != nil {
		return err
	}
	return publishFile(t.root, filepath.Join(dir, stageMetadataFile), raw, ownerMode, true)
}

// ReadStageMetadataScope отдаёт безопасный код причины вместо диагностических путей.
// Неподтверждённая запись отключает ускорение без отказа каталога модели и effort.
func (s Store) ReadStageMetadataScope(attempt Attempt) (*StageMetadataScope, string) {
	if !attemptPattern.MatchString(attempt.ID) || !profilePattern.MatchString(attempt.Profile) {
		return nil, "corrupt"
	}
	task, err := s.openTask(attempt.Task, false)
	if err != nil {
		return nil, "absent"
	}
	defer task.close()
	return task.readStageMetadataScope(attempt)
}

// readStageMetadataScope проверяет identity и отбрасывает только непригодные копии.
// Тот же путь чтения используется под lock при подтверждении сохранения настройки.
func (t *taskState) readStageMetadataScope(attempt Attempt) (*StageMetadataScope, string) {
	active, err := t.activeAttempt(attempt.Task)
	if err != nil {
		return nil, "absent"
	}
	if active != attempt.ID {
		return nil, "corrupt"
	}
	dir := filepath.Join("attempts", attempt.ID)
	if err := ensurePrivateDirectory(t.root, dir, false); err != nil {
		return nil, "absent"
	}
	raw, err := readTrusted(t.root, filepath.Join(dir, stageMetadataFile), stageMetadataLimit, ownerMode)
	if errors.Is(err, os.ErrNotExist) {
		return nil, "absent"
	}
	if err != nil || !jsontext.Value(raw).IsValid() {
		return nil, "corrupt"
	}
	var scope StageMetadataScope
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&scope) != nil || scope.Schema != 1 || scope.Task != attempt.Task ||
		scope.Profile != attempt.Profile || scope.Attempt != attempt.ID || scope.Providers == nil ||
		!scope.validEnvironment() {
		return nil, "corrupt"
	}
	problem := ""
	for _, provider := range slices.Sorted(maps.Keys(scope.Providers)) {
		entry := scope.Providers[provider]
		if provider != "codex" && provider != "claude" {
			return nil, "corrupt"
		}
		if !entry.available() {
			delete(scope.Providers, provider)
			problem = "entry_unavailable:" + provider
		}
	}
	return &scope, problem
}

// available подтверждает набор полей и digest выбранного физического файла.
// Пустые внешние поля допустимы только вместе у локальной копии.
func (entry StageMetadataCLI) available() bool {
	if !digestPattern.MatchString(entry.Digest) || (!entry.local() && !entry.ValidExternal()) {
		return false
	}
	digest, err := StageMetadataExecutableDigest(entry.Executable)
	return err == nil && digest == entry.Digest
}
