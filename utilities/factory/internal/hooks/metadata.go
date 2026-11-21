package hooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/runner"
)

var (
	profileServiceHost = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$`)
)

type ProfileGraph struct {
	RouteV2   bool
	Nonlaunch bool
}

// ProfileFiles определяет канонические имена файлов выбранного проекта.
// Имя проекта проверяется CLI до построения этих путей.
func ProfileFiles(profile string) (script, graph, runners string) {
	dir := filepath.Join(ProfileRoot(), profile)
	return filepath.Join(dir, "profile.sh"), filepath.Join(dir, "graph.json"),
		filepath.Join(dir, "runners.env")
}

// ProfileRoot выбирает только корень выбранной установки.
// Переносимый бинарник поддерживает явный FACTORY_HOME из resolver.
func ProfileRoot() string {
	root := os.Getenv("FACTORY_PROFILES_DIR")
	if root == "" {
		home := os.Getenv("FACTORY_HOME")
		if home == "" {
			executable, _ := os.Executable()
			home = runner.FactoryHome(nil, executable)
		}
		root = filepath.Join(filepath.Dir(home), "profiles")
	}
	return root
}

// CheckFile допускает существующий обычный файл по абсолютному пути.
// Профили и входные документы проверяются до чтения или передачи в Bash.
func CheckFile(path, label string) error {
	if !filepath.IsAbs(path) || strings.ContainsAny(path, "\n\t") {
		return fmt.Errorf("%s: нужен существующий абсолютный обычный файл", label)
	}
	stat, err := os.Lstat(path)
	if err != nil || !stat.Mode().IsRegular() {
		return fmt.Errorf("%s: нужен существующий абсолютный обычный файл", label)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("%s: путь не разрешается", label)
	}
	if resolved != path {
		return fmt.Errorf("%s: symlink-компоненты запрещены", label)
	}

	return nil
}

// RequireRouteV2 проверяет объявление в отдельном физическом graph.json.
// Профиль с одними legacy-хуками отклоняется без запуска Bash.
func RequireRouteV2(graph, profile string) error {
	metadata, err := ReadProfileGraph(graph)
	if err != nil {
		return err
	}
	if metadata.RouteV2 {
		return nil
	}
	return fmt.Errorf("профиль %s не заявляет capability %q в graph.json", profile, "route-v2")
}

// ReadProfileGraph проверяет физический JSON без выполнения профильного скрипта.
// launchable=false представляет отдельную декларацию для команды проверки.
func ReadProfileGraph(graph string) (ProfileGraph, error) {
	if err := CheckFile(graph, "graph"); err != nil {
		return ProfileGraph{}, err
	}
	data, err := os.ReadFile(graph)
	if err != nil {
		return ProfileGraph{}, fmt.Errorf("graph: %w", err)
	}
	var document struct {
		Capabilities []any `json:"capabilities"`
		Launchable   any   `json:"launchable"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return ProfileGraph{}, nil
	}
	return ProfileGraph{
		RouteV2: slices.Contains(document.Capabilities, "route-v2"), Nonlaunch: document.Launchable == false,
	}, nil
}

// RunnerConfig читает канонические присваивания без shell expansion.
// Схема файла 1 используется независимо от версии жизненного цикла фабрики.
func RunnerConfig(path string) (map[string]string, error) {
	if err := CheckFile(path, "runners-config"); err != nil {
		return nil, err
	}
	profile, err := runner.ReadProfile(path)
	if err != nil {
		return nil, err
	}
	if profile.Values["RUNNERS_COVERAGE"] != "required" {
		return nil, fmt.Errorf("runners.env обязан требовать coverage")
	}
	return profile.Values, nil
}

// CheckProfileHooks проверяет объявления и текущие ветки, не вызывая up и command.
// Хост сервиса проверяется в Go до использования при создании URL.
func CheckProfileHooks(ctx context.Context, invocation Invocation) error {
	result := runBridge(ctx, invocation, "check-hooks")
	err := hookFailure("route", result)
	if host := strings.TrimSpace(string(result.Stdout)); host != "" && !profileServiceHost.MatchString(host) {
		const message = "хост стенда: нужно голое имя хоста или адрес, без схемы, порта и слэшей"
		err = errors.Join(err, errors.New(message))
	}
	return err
}

type SlotUse struct {
	K   int    `json:"k"`
	By  string `json:"by"`
	Why string `json:"why"`
}

// ListSlots возвращает прежний JSON-формат на основе строк RANGE и USED.
// Профиль без функции распределителя сохраняет supported=false.
func ListSlots(ctx context.Context, profile, script, state string) (map[string]any, int, error) {
	env := append(os.Environ(), "STATE_DIR="+state, "FACTORY_STATE="+state)
	invocation := Invocation{
		Profile: script, Directory: filepath.Dir(script), Env: env, Timeout: 30 * time.Second,
	}
	result := runBridge(ctx, invocation, "slots")
	head, body, _ := strings.Cut(string(result.Stdout), "\n")
	if !result.OutputOverflow && result.RC == 0 && head == "absent" {
		return map[string]any{
			"profile": profile, "supported": false, "used": []SlotUse{}, "free": []int{},
		}, 0, nil
	}
	if head != "present" || result.OutputOverflow {
		if err := hookFailure("slots", result); err != nil {
			return nil, result.RC, err
		}
		return nil, 78, fmt.Errorf("slots: не получен ответ профиля")
	}
	return formatSlots(profile, body)
}

// formatSlots преобразует подтверждённый диапазон в очередь занятых и свободных.
// Текст ошибки остаётся отдельным полем ответа для прежних потребителей.
func formatSlots(profile, input string) (map[string]any, int, error) {
	var lo, hi int
	have := false
	slots := make(map[int]SlotUse)
	message := ""
	for line := range strings.SplitSeq(input, "\n") {
		items := strings.Fields(line)
		if len(items) == 0 {
			continue
		}
		switch items[0] {
		case "ERROR":
			message = strings.TrimPrefix(line, "ERROR ")
		case "RANGE":
			if len(items) >= 3 {
				var firstErr, lastErr error
				lo, firstErr = strconv.Atoi(items[1])
				hi, lastErr = strconv.Atoi(items[2])
				have = firstErr == nil && lastErr == nil && lo >= 0 && hi >= lo && hi-lo < 10000
			}
		case "USED":
			if len(items) >= 2 {
				n, err := strconv.Atoi(items[1])
				if err == nil {
					fields := append(items, "", "")
					slots[n] = SlotUse{K: n, By: fields[2], Why: fields[3]}
				}
			}
		}
	}
	if message == "" && !have {
		message = "профиль не вернул диапазон слотов"
	}
	if message != "" {
		return map[string]any{"profile": profile, "error": message}, 3, nil
	}
	used, free := []SlotUse{}, []int{}
	for offset := 0; offset <= hi-lo; offset++ {
		n := lo + offset
		if busy, exists := slots[n]; exists {
			used = append(used, busy)
		} else {
			free = append(free, n)
		}
	}
	return map[string]any{"profile": profile, "range": [2]int{lo, hi}, "used": used, "free": free}, 0, nil
}
