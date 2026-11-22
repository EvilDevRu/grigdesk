package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

type DebugSetting struct {
	Level             string
	Expires, Revision int64
}

type DebugResolution struct {
	Level, Source string
	Expires       int64
}

var debugLevels = []string{"inherit", "off", "errors", "decisions", "verbose"}

func (setting DebugSetting) Valid() bool {
	return slices.Contains(debugLevels, setting.Level) && setting.Expires >= 0 && setting.Revision >= 0
}

func (setting DebugSetting) active(now int64) bool {
	return setting.Level != "inherit" && (setting.Expires == 0 || setting.Expires > now)
}

// ReadDebugFile принимает те же поля, что исторический reader.
// Физические файлы открываются внутри отдельного каталога настроек.
func ReadDebugFile(config, profile string) (DebugSetting, error) {
	root, name, err := openDebugDir(config, profile, false)
	if err != nil {
		return DebugSetting{}, err
	}
	defer root.Close()
	return readDebugFile(root, name)
}

// WriteDebugFile сериализует запись с историческим flock на том же имени.
// Снимок целиком публикуется rename, а версия всегда берётся под lock.
func WriteDebugFile(config, profile string, setting DebugSetting) error {
	if !setting.Valid() {
		return fmt.Errorf("некорректная настройка диагностики")
	}
	dir, name, err := openDebugDir(config, profile, true)
	if err != nil {
		return err
	}
	defer dir.Close()
	lock, err := openNamedLock(dir, name+".lock")
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := flock(lock, lockExclusive); err != nil {
		return err
	}
	current, err := readDebugFile(dir, name)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	revision := current.Revision + 1
	if revision <= 0 {
		return fmt.Errorf("исчерпан диапазон ревизий диагностики")
	}
	raw := fmt.Appendf(nil, "DEBUG_SCHEMA=1\nCONFIG_REVISION=%d\nLEVEL=%s\nEXPIRES_AT=%d\n",
		revision, setting.Level, setting.Expires)
	return publishFile(dir, name, raw, ownerMode, true)
}

// openDebugDir проверяет относительные имена и владельца каталога настроек.
// Профильное имя не может выбрать другой файл или выйти из debug/profiles.
func openDebugDir(config, profile string, create bool) (*os.Root, string, error) {
	if profile != "" && !profilePattern.MatchString(profile) {
		return nil, "", fmt.Errorf("неверное имя профиля диагностики")
	}
	root, err := openControl(config, create)
	if err != nil {
		return nil, "", err
	}
	defer root.Close()
	dir, name := "debug", "global.env"
	if err := ensurePrivateDirectory(root, dir, create); err != nil {
		return nil, "", err
	}
	if profile != "" {
		dir, name = "debug/profiles", profile+".env"
		if err := ensurePrivateDirectory(root, dir, create); err != nil {
			return nil, "", err
		}
	}
	subdir, err := root.OpenRoot(dir)
	return subdir, name, err
}

// readDebugFile отклоняет дубликаты и неканонические числа.
// Локальный конфиг остаётся данными и никогда не исполняется оболочкой.
func readDebugFile(root *os.Root, name string) (DebugSetting, error) {
	raw, err := readTrusted(root, name, 16*1024, ownerMode)
	if errors.Is(err, os.ErrNotExist) {
		return DebugSetting{Level: "inherit"}, nil
	}
	if err != nil {
		return DebugSetting{}, err
	}
	values := make(map[string]string)
	for row := range strings.SplitSeq(string(raw), "\n") {
		if row == "" || strings.HasPrefix(row, "#") {
			continue
		}
		key, value, ok := strings.Cut(row, "=")
		if _, seen := values[key]; !ok || seen {
			return DebugSetting{}, fmt.Errorf("повреждённая настройка диагностики")
		}
		values[key] = value
	}
	setting := DebugSetting{Level: values["LEVEL"], Expires: canonicalDebugNumber(values["EXPIRES_AT"]),
		Revision: canonicalDebugNumber(values["CONFIG_REVISION"])}
	if len(values) != 4 || values["DEBUG_SCHEMA"] != "1" || !setting.Valid() {
		return DebugSetting{}, fmt.Errorf("повреждённая настройка диагностики")
	}
	return setting, nil
}

func canonicalDebugNumber(value string) int64 {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != value {
		return -1
	}
	return n
}

// ResolveDebug наследует активную настройку задачи и профиля в рамках глобального потолка.
// Повреждённая конфигурация закрывает диагностику, а продуктовый запуск может продолжаться.
func ResolveDebug(config, profile string, task DebugSetting, now int64) DebugResolution {
	if !task.Valid() {
		return DebugResolution{Level: "off", Source: "invalid_task"}
	}
	chosen := DebugResolution{Level: "inherit"}
	if task.active(now) {
		chosen = DebugResolution{task.Level, "task", task.Expires}
	} else if profile != "" {
		local, err := ReadDebugFile(config, profile)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return DebugResolution{Level: "off", Source: "invalid_profile"}
		}
		if err == nil && local.active(now) {
			chosen = DebugResolution{local.Level, "profile", local.Expires}
		}
	}
	global := DebugResolution{Level: "off", Source: "default"}
	file, err := ReadDebugFile(config, "")
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return DebugResolution{Level: "off", Source: "invalid_global"}
	}
	if err == nil && file.active(now) {
		global = DebugResolution{file.Level, "global", file.Expires}
	}
	if chosen.Level == "inherit" {
		return global
	}
	if slices.Index(debugLevels, chosen.Level) > slices.Index(debugLevels, global.Level) {
		global.Source = "global_cap"
		return global
	}
	if global.Expires > 0 && (chosen.Expires == 0 || global.Expires < chosen.Expires) {
		chosen.Expires = global.Expires
	}
	return chosen
}

// ReadTaskDebug открывает активную попытку по указателю, а её проекцию — лишь для debug полей.
// Настройка из строки предыдущей попытки не применяется к новой.
func (s Store) ReadTaskDebug(task string) (Attempt, DebugSetting, error) {
	t, err := s.openTask(task, false)
	if err != nil {
		return Attempt{}, DebugSetting{}, err
	}
	defer t.close()
	id, err := t.activeAttempt(task)
	if err != nil {
		return Attempt{}, DebugSetting{}, err
	}
	a, err := t.readAttempt(task, id)
	if err != nil {
		return Attempt{}, DebugSetting{}, err
	}
	root, err := openControl(s.StateDir, false)
	if err != nil {
		return Attempt{}, DebugSetting{}, err
	}
	defer root.Close()
	_, raw, err := findProjection(root, "t"+task+".pipeline")
	if err != nil {
		return Attempt{}, DebugSetting{}, err
	}
	setting := DebugSetting{Level: "inherit"}
	var identity string
	for line := range strings.SplitSeq(string(raw), "\n") {
		key, value, _ := strings.Cut(line, "=")
		switch key {
		case "ATTEMPT_ID":
			identity = value
		case "DEBUG_LEVEL":
			if value != "" {
				setting.Level = value
			}
		case "DEBUG_EXPIRES_AT":
			if value != "" {
				setting.Expires = canonicalDebugNumber(value)
			}
		}
	}
	if identity != a.ID || a.Terminal != "" {
		err := fmt.Errorf("%w: витрина диагностики относится к другой попытке", ErrConflict)
		return Attempt{}, DebugSetting{}, err
	}
	return a, setting, nil
}

// WriteTaskDebug подтверждает неизменную активную попытку до записи проекции.
// Никакой runner config или курсор не меняется от уровня диагностики.
func (s Store) WriteTaskDebug(a Attempt, setting DebugSetting) error {
	if !setting.Valid() {
		return fmt.Errorf("некорректная настройка диагностики")
	}
	t, err := s.openTask(a.Task, false)
	if err != nil {
		return err
	}
	defer t.close()
	active, err := t.activeAttempt(a.Task)
	if err != nil || active != a.ID || a.Terminal != "" {
		return fmt.Errorf("%w: попытка диагностики изменилась", ErrConflict)
	}
	return s.writeProjection(a.Task, []ProjectionField{
		{Key: "DEBUG_LEVEL", Value: setting.Level},
		{Key: "DEBUG_EXPIRES_AT", Value: strconv.FormatInt(setting.Expires, 10)},
	})
}

func DebugConfigRoot(env map[string]string) string {
	if root := env["FACTORY_CONFIG_ROOT"]; root != "" {
		return root
	}
	return filepath.Join(env["HOME"], ".factory", "config")
}
