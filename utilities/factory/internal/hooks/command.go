package hooks

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"grigdesk.local/tools/utilities/factory/internal/hooks/bash"
	"grigdesk.local/tools/utilities/factory/internal/host"
)

type Invocation struct {
	Profile   string
	Directory string
	Env       []string
	Files     []*os.File
	Timeout   time.Duration
	Owned     bool
}

type CommandInput struct {
	Task, Route, Node, RunKey, CommandID, ContextFile string
}

type Finding struct {
	ID, Summary, Anchor, Severity string
}

type CommandVerdict struct {
	Outcome, Comment, FailureOwner string
	Findings                       []Finding
	Reviewed                       []string
}

const hookOutputLimit = 64 * 1024

var (
	commandTask    = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
	commandEntity  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,40}$`)
	commandRunKey  = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	commandFinding = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	commandOwners  = []string{"build", "tests", "environment", "plan", "human"}
)

// RunCommand исполняет только выбранный фабрикой command-хук.
// Принимается один проверенный объект stdout, отдельно от диагностик профиля.
func RunCommand(ctx context.Context, invocation Invocation, input CommandInput) (CommandVerdict, int, error) {
	if !commandTask.MatchString(input.Task) || !commandEntity.MatchString(input.Route) ||
		!commandEntity.MatchString(input.Node) || !commandRunKey.MatchString(input.RunKey) ||
		!commandEntity.MatchString(input.CommandID) {
		return CommandVerdict{}, 78, fmt.Errorf("command: недопустимый идентификатор вызова")
	}
	if err := CheckFile(input.ContextFile, "context"); err != nil {
		return CommandVerdict{}, 78, err
	}
	result := runBridge(ctx, invocation, "command",
		input.Task, input.Route, input.Node, input.RunKey, input.CommandID, input.ContextFile)
	if err := hookFailure("command", result); err != nil {
		return CommandVerdict{}, result.RC, err
	}
	if result.OutputOverflow {
		return CommandVerdict{}, 78, fmt.Errorf("command: stdout превышает 64 KiB")
	}
	verdict, err := parseCommandVerdict(result.Stdout)
	if err != nil {
		return CommandVerdict{}, 78, err
	}
	return verdict, 0, nil
}

// runBridge передаёт опции только позиционными аргументами встроенному Bash.
// Переменные и дескрипторы должен явно предоставить вызывающий код.
func runBridge(
	ctx context.Context, invocation Invocation, operation string, args ...string,
) host.ProcessResult {
	command, err := bridgeProcess(invocation, operation, args...)
	if err != nil {
		return host.ProcessResult{RC: 78, Err: err}
	}
	return host.RunProcess(ctx, command)
}

func bridgeProcess(invocation Invocation, operation string, args ...string) (host.Process, error) {
	if err := CheckFile(invocation.Profile, "profile"); err != nil {
		return host.Process{}, err
	}
	if err := checkWorkingDirectory(invocation.Directory); err != nil {
		return host.Process{}, err
	}
	shell, err := profileShell()
	if err != nil {
		return host.Process{}, err
	}
	argv := append([]string{"--noprofile", "--norc", "-c", bash.Bridge, "factory-profile",
		invocation.Profile, operation}, args...)
	return host.Process{
		Path: shell, Args: argv, Dir: invocation.Directory, Env: hookEnvironment(invocation.Env),
		Files: invocation.Files, Timeout: invocation.Timeout, Limit: hookOutputLimit, Owned: invocation.Owned,
	}, nil
}

// InstrumentationRestored синхронизирует существующий shared-стенд после restore.
// Hook получает задачу и readonly список уже подтверждённых путей.
func InstrumentationRestored(ctx context.Context, invocation Invocation, task, scope string) error {
	result := runBridge(ctx, invocation, "instrumentation-restored", task, scope)
	return hookFailure("синхронизация стенда после инструментации", result)
}

// hookEnvironment исключает неявный source и импорт функций оболочки.
// Передача capability процесса через env требует отдельного канала этапа.
func hookEnvironment(values []string) []string {
	result := make([]string, 0, len(values))
	for _, entry := range values {
		key, _, _ := strings.Cut(entry, "=")
		if key != "BASH_ENV" && key != "ENV" && key != "FACTORY_STATUS_FD" &&
			!strings.HasPrefix(key, "BASH_FUNC_") && !strings.HasPrefix(key, "FACTORY_RUN_") {
			result = append(result, entry)
		}
	}
	return result
}

// hookFailure оформляет диагностический результат завершившегося процесса.
// Stdout остаётся отдельным входом DTO и не включается в stderr.
func hookFailure(operation string, result host.ProcessResult) error {
	if result.RC == 0 {
		return nil
	}
	if text := strings.TrimSpace(string(result.Stderr)); text != "" {
		return fmt.Errorf("%s: %s (код %d)", operation, text, result.RC)
	}
	return fmt.Errorf("%s: %w (код %d)", operation, result.Err, result.RC)
}

// parseCommandVerdict сверяет форму и семантику результата trusted command.
// Повреждённый stdout нельзя превращать в продуктовый исход узла.
func parseCommandVerdict(data []byte) (CommandVerdict, error) {
	verdict := CommandVerdict{}
	var fields map[string]json.RawMessage
	if !utf8.Valid(data) || json.Unmarshal(data, &fields) != nil || fields == nil {
		return verdict, fmt.Errorf("command: stdout должен содержать один объект JSON")
	}
	required := []string{"schema", "outcome", "comment", "failureOwner", "findings"}
	if !matchingFields(fields, required, []string{"reviewed"}) {
		return verdict, fmt.Errorf("command: неверный набор полей вердикта")
	}
	if string(fields["schema"]) != "1" ||
		json.Unmarshal(fields["outcome"], &verdict.Outcome) != nil ||
		!slices.Contains([]string{"done", "skipped", "failed"}, verdict.Outcome) ||
		json.Unmarshal(fields["comment"], &verdict.Comment) != nil || !commandText(verdict.Comment, 2000) ||
		json.Unmarshal(fields["failureOwner"], &verdict.FailureOwner) != nil {
		return verdict, fmt.Errorf("command: недопустимые schema/outcome/comment/failureOwner")
	}
	var rawFindings []map[string]json.RawMessage
	if err := json.Unmarshal(fields["findings"], &rawFindings); err != nil || rawFindings == nil {
		return verdict, fmt.Errorf("command: findings должен быть массивом")
	}
	if err := verdict.readFindings(rawFindings, fields); err != nil {
		return CommandVerdict{}, err
	}
	return verdict, nil
}

// matchingFields запрещает отсутствующие обязательные и неизвестные поля.
// Опциональные поля не расширяют полномочия самого вызова.
func matchingFields(fields map[string]json.RawMessage, required, optional []string) bool {
	for _, key := range required {
		if _, exists := fields[key]; !exists {
			return false
		}
	}
	for key := range fields {
		if !slices.Contains(required, key) && !slices.Contains(optional, key) {
			return false
		}
	}
	return true
}

// commandText принимает краткий печатный текст комментария или находки.
// Управляющие символы не могут менять запись результата.
func commandText(value string, limit int) bool {
	control := strings.ContainsFunc(value, func(char rune) bool {
		return char < 32 || char == 127
	})
	return value != "" && utf8.RuneCountInString(value) <= limit && !control
}

// readFindings сохраняет ограничения по outcome и уникальности id.
// У done с findings все записи отложенные, failed обязан содержать блокирующую.
func (v *CommandVerdict) readFindings(
	raw []map[string]json.RawMessage, fields map[string]json.RawMessage,
) error {
	v.Findings = make([]Finding, 0, len(raw))
	if len(raw) == 0 {
		if v.Outcome == "failed" || string(fields["failureOwner"]) != "null" {
			return fmt.Errorf("command: owner/findings не соответствуют исходу")
		}
		return nil
	}
	if len(raw) > 32 || v.Outcome == "skipped" {
		return fmt.Errorf("command: findings не соответствуют исходу")
	}
	if v.Outcome == "failed" || string(fields["failureOwner"]) != "null" {
		if !slices.Contains(commandOwners, v.FailureOwner) {
			return fmt.Errorf("command: недопустимый failureOwner")
		}
	}
	seen := make(map[string]bool)
	blocking := 0
	for _, value := range raw {
		finding, err := parseCommandFinding(value)
		if err != nil {
			return err
		}
		if seen[finding.ID] {
			return fmt.Errorf("command: повтор id находки %s", finding.ID)
		}
		seen[finding.ID] = true
		if finding.Severity != "deferred" {
			blocking++
		}
		v.Findings = append(v.Findings, finding)
	}
	if (v.Outcome == "failed") != (blocking != 0) {
		return fmt.Errorf("command: тип находок противоречит исходу")
	}
	if reviewed, exists := fields["reviewed"]; exists && string(reviewed) != "null" {
		if err := v.readReviewed(reviewed); err != nil {
			return err
		}
	}
	return nil
}

// parseCommandFinding переносит только проверенные свойства одной находки.
// Пустой Severity представляет исторический blocking по умолчанию.
func parseCommandFinding(fields map[string]json.RawMessage) (Finding, error) {
	finding := Finding{}
	if !matchingFields(fields, []string{"id", "summary"}, []string{"anchor", "severity"}) ||
		json.Unmarshal(fields["id"], &finding.ID) != nil || !commandFinding.MatchString(finding.ID) ||
		json.Unmarshal(fields["summary"], &finding.Summary) != nil || !commandText(finding.Summary, 500) {
		return finding, fmt.Errorf("command: неверная находка")
	}
	if raw, exists := fields["anchor"]; exists {
		if json.Unmarshal(raw, &finding.Anchor) != nil || !artifactPath(finding.Anchor) {
			return finding, fmt.Errorf("command: неверный anchor находки")
		}
	}
	if raw, exists := fields["severity"]; exists {
		if json.Unmarshal(raw, &finding.Severity) != nil ||
			(finding.Severity != "blocking" && finding.Severity != "deferred") {
			return finding, fmt.Errorf("command: неверный severity находки")
		}
		if finding.Severity == "blocking" {
			finding.Severity = ""
		}
	}
	return finding, nil
}

func artifactPath(value string) bool {
	return commandText(value, 200) && !strings.HasPrefix(value, "/") &&
		!slices.Contains(strings.Split(value, "/"), "..")
}

// readReviewed проверяет список просмотренных относительных артефактов.
// Поле имеет смысл только внутри результата с доказанными findings.
func (v *CommandVerdict) readReviewed(data []byte) error {
	if json.Unmarshal(data, &v.Reviewed) != nil || len(v.Reviewed) < 1 || len(v.Reviewed) > 64 {
		return fmt.Errorf("command: неверный список reviewed")
	}
	seen := make(map[string]bool)
	for _, name := range v.Reviewed {
		if !artifactPath(name) || seen[name] {
			return fmt.Errorf("command: недопустимый или повторный reviewed")
		}
		seen[name] = true
	}
	return nil
}
