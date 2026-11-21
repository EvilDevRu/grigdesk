package hooks

import (
	"context"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"fmt"
	"grigdesk.local/tools/utilities/factory/internal/host"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

type Repository struct {
	Name, Source, Worktree, Branch string
}

type Workspace struct {
	Mode, Stand, Container, Host string
	FrontPort, APIPort, Delivery string
	Repositories                 []Repository
	Resources                    []string
	Project                      []byte
	LoopRounds                   *string
}

var repositoryName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var workspaceBranch = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$`)
var workspaceContainer = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`)

// ReadWorkspace вызывает фиксированный набор профильных хуков и проверяет DTO.
// Значения профиля не исполняются как shell assignments или команды.
func ReadWorkspace(ctx context.Context, inv Invocation, task string) (Workspace, int, error) {
	result := runBridge(ctx, inv, "workspace", task)
	if err := hookFailure("workspace", result); err != nil {
		return Workspace{}, result.RC, err
	}
	if result.OutputOverflow {
		return Workspace{}, 78, fmt.Errorf("workspace: ответ профиля слишком большой")
	}
	w, err := parseWorkspace(string(result.Stdout))
	if err != nil {
		return Workspace{}, 78, err
	}
	return w, 0, nil
}

// parseWorkspace читает TSV заголовок и ровно один JSON project-context.
// Строки так же адресуются как значения отдельных хуков Bash.
func parseWorkspace(raw string) (Workspace, error) {
	var w Workspace
	header, project, present := strings.Cut(raw, "\ncontext\n")
	if !present {
		return w, fmt.Errorf("workspace: отсутствует project-context")
	}
	seen := make(map[string]bool)
	for _, line := range strings.Split(header, "\n") {
		fields := strings.Split(line, "\t")
		key := fields[0]
		if len(fields) < 2 || (seen[key] && key != "repo" && key != "resource") {
			return w, fmt.Errorf("workspace: неполное или повторное поле %s", key)
		}
		seen[key] = true
		if err := w.applyField(key, fields[1:]); err != nil {
			return w, err
		}
	}
	canonical, err := workspaceProject(project)
	if err != nil {
		return w, err
	}
	w.Project = canonical
	return w, w.validate()
}

func (w *Workspace) applyField(key string, value []string) error {
	want := 1
	switch key {
	case "repo":
		want = 4
	case "ports":
		want = 2
	}
	if len(value) != want {
		return fmt.Errorf("workspace: неверное число полей для %s", key)
	}
	first := value[0]
	switch key {
	case "workspace":
		w.Mode = first
	case "stand":
		w.Stand = first
	case "container":
		w.Container = first
	case "service":
		w.Host = first
	case "ports":
		w.FrontPort, w.APIPort = first, value[1]
	case "delivery":
		w.Delivery = first
	case "loop-rounds":
		w.LoopRounds = &first
	case "repo":
		w.Repositories = append(w.Repositories, Repository{first, filepath.FromSlash(value[1]), filepath.FromSlash(value[2]), value[3]})
	case "resource":
		w.Resources = append(w.Resources, first)
	default:
		return fmt.Errorf("workspace: неизвестное поле %s", key)
	}
	return nil
}

// validate проверяет физические пути источников до provisioning.
// В isolated checkout может ещё отсутствовать, но его адрес уже закреплён.
func (w Workspace) validate() error {
	if (w.Mode != "shared" && w.Mode != "isolated") || !workspaceContainer.MatchString(w.Container) ||
		!profileServiceHost.MatchString(w.Host) ||
		(w.Stand != "" && w.Stand != "services" && !(w.Mode == "isolated" && w.Stand == "none")) {
		return fmt.Errorf("workspace: недопустимый mode, stand, container или service host")
	}
	if len(w.Repositories) == 0 || len(w.Repositories) > 16 {
		return fmt.Errorf("workspace: требуется от 1 до 16 репозиториев")
	}
	if w.Mode == "shared" {
		if len(w.Resources) == 0 || !validPort(w.FrontPort) || !validPort(w.APIPort) {
			return fmt.Errorf("workspace: shared требует порты и явно закреплённые ресурсы")
		}
	}
	names := make(map[string]bool)
	for index, repo := range w.Repositories {
		if !repo.valid() || names[repo.Name] {
			return fmt.Errorf("workspace: неверный репозиторий %s", repo.Name)
		}
		names[repo.Name] = true
		if err := checkWorkingDirectory(repo.Source); err != nil {
			return err
		}
		if w.Mode == "shared" && repo.Source != repo.Worktree {
			return fmt.Errorf("workspace: shared checkout должен совпасть с source")
		}
		if w.Mode == "isolated" && repo.Branch != w.Repositories[0].Branch {
			return fmt.Errorf("workspace: isolated использует одну ветку задачи")
		}
		for otherIndex, other := range w.Repositories {
			compareSource := w.Mode == "isolated" || index != otherIndex
			if index != otherIndex && checkoutOverlap(repo.Worktree, other.Worktree) ||
				compareSource && checkoutOverlap(repo.Worktree, other.Source) {
				return fmt.Errorf("workspace: пересекаются source и checkout")
			}
		}
	}
	return nil
}

func (r Repository) valid() bool {
	if !repositoryName.MatchString(r.Name) || !workspaceBranch.MatchString(r.Branch) ||
		strings.Contains(r.Branch, "..") {
		return false
	}
	for _, item := range []string{r.Source, r.Worktree} {
		if !validCheckoutPath(item) {
			return false
		}
	}
	return true
}

func validPort(value string) bool {
	port, err := strconv.ParseUint(value, 10, 16)
	return err == nil && port > 0 && value == strconv.FormatUint(port, 10)
}

func checkoutOverlap(a, b string) bool {
	return host.PathsOverlap(a, b)
}

// workspaceProject выдаёт compact JSON с прежними именами и границами списков.
// Равенство байтов требуется при resume и при смешанном чтении артефактов.
func workspaceProject(raw string) ([]byte, error) {
	var values map[string][]string
	if len(raw) > 32768 || !jsontext.Value(raw).IsValid() ||
		jsonv2.Unmarshal([]byte(raw), &values) != nil || len(values) != 2 {
		return nil, fmt.Errorf("profile_project_context: неверный JSON")
	}
	stack, guardrails := values["stack"], values["guardrails"]
	if len(stack) < 1 || len(stack) > 64 || guardrails == nil || len(guardrails) > 100 {
		return nil, fmt.Errorf("profile_project_context: неверный stack или guardrails")
	}
	for _, key := range []string{"stack", "guardrails"} {
		limit := 500
		if key == "guardrails" {
			limit = 2000
		}
		for _, value := range values[key] {
			if value == "" || utf8.RuneCountInString(value) > limit {
				return nil, fmt.Errorf("profile_project_context: невалидная строка %s", key)
			}
		}
	}
	value, err := jsonv2.Marshal(values, jsonv2.Deterministic(true))
	return append(value, '\n'), err
}
