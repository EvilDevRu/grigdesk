package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

type statusCommand struct {
	identity   state.RunIdentity
	submission state.StatusSubmission
}

// runStatus ограничивает CLI двумя операциями над выданным правом запуска.
// Режим очереди открывает только writable state, а результат утверждает host.
func runStatus(verb string, tokens []string, diagnostic io.Writer) int {
	command, err := parseStatusCommand(verb, tokens)
	if err != nil {
		return statusError(diagnostic, verb, 2, err)
	}
	id := command.identity
	if !statusEnvironmentMatches(id) {
		return statusError(diagnostic, verb, 74, fmt.Errorf("контекст активного запуска не совпадает"))
	}
	store := state.Store{
		ControlDir: os.Getenv("FACTORY_CONTROL_ROOT"),
		StateDir:   firstNonempty(os.Getenv("FACTORY_STATE"), os.Getenv("STATE_DIR")),
	}
	input := command.submission
	mode := os.Getenv("FACTORY_STATUS_MODE")
	var capability string
	if mode != "request" {
		capability, err = readStatusCapability(firstNonempty(os.Getenv("FACTORY_STATUS_FD"), "7"))
		if err != nil {
			return statusError(diagnostic, verb, 74, err)
		}
	}
	if input.Result != "" {
		if rc := verifyStatusPreflight(id, input.Result, diagnostic); rc != 0 {
			return rc
		}
	}
	var rc int
	switch {
	case mode == "request":
		rc, err = store.QueueStatus(id, os.Getenv("FACTORY_STATUS_REQUEST_DIR"), input)
	case input.Result != "":
		rc, err = store.ApplyRunResult(id, capability, input.Result, input.Comment, input.Verdict)
	default:
		rc, err = store.ApplyRunProgress(id, capability, input.Progress)
	}
	return statusError(diagnostic, verb, rc, err)
}

func statusError(output io.Writer, verb string, rc int, err error) int {
	if err != nil {
		fmt.Fprintf(output, "%s: %s\n", verb, err)
	}
	return rc
}

func statusEnvironmentMatches(id state.RunIdentity) bool {
	return id.Task == os.Getenv("FACTORY_RUN_TASK") && id.Stage == os.Getenv("FACTORY_RUN_STAGE") &&
		id.ID == os.Getenv("FACTORY_RUN_ID") && id.Attempt == os.Getenv("FACTORY_RUN_ATTEMPT") &&
		strconv.FormatUint(id.Epoch, 10) == os.Getenv("FACTORY_RUN_EPOCH")
}

// parseStatusCommand читает прежние argv stage-result и stage-progress.
// Для progress остаток после identity состоит только из пар ключ/значение.
func parseStatusCommand(verb string, args []string) (statusCommand, error) {
	var command statusCommand
	values := make(map[string]string)
	identityOptions := map[string]bool{"--task": true, "--stage": true, "--run-id": true, "--epoch": true}
	for len(args) > 0 && identityOptions[args[0]] {
		if len(args) < 2 || values[args[0]] != "" || args[1] == "" {
			return command, fmt.Errorf("нужна однозначная identity запуска")
		}
		values[args[0]], args = args[1], args[2:]
	}
	epoch, err := strconv.ParseUint(values["--epoch"], 10, 64)
	task := strings.TrimPrefix(strings.TrimPrefix(values["--task"], "t"), "T")
	command.identity = state.RunIdentity{
		Task: task, Attempt: os.Getenv("FACTORY_RUN_ATTEMPT"), Stage: values["--stage"],
		ID: values["--run-id"], Epoch: epoch,
	}
	if err != nil || values["--epoch"] != strconv.FormatUint(epoch, 10) || !command.identity.Valid() {
		return command, fmt.Errorf("нужны task, stage, run-id и точная epoch")
	}
	if verb == "stage-progress" {
		command.submission.Progress, err = statusProgressArgs(command.identity.Stage, args)
	} else {
		command.submission, err = statusResultArgs(args)
	}
	return command, err
}

func statusProgressArgs(stage string, args []string) ([]state.ProjectionField, error) {
	if len(args)%2 != 0 {
		return nil, fmt.Errorf("progress требует пары ключ/значение")
	}
	updates := make([]state.ProjectionField, 0, len(args)/2)
	for i := 0; i < len(args); i += 2 {
		updates = append(updates, state.ProjectionField{Key: args[i], Value: args[i+1]})
	}
	return updates, state.ValidateRunProgress(stage, updates)
}

// statusResultArgs разбирает типизированные дополнения вердикта.
// Все значения передаются как argv и сохраняются отдельно от комментария.
func statusResultArgs(args []string) (state.StatusSubmission, error) {
	var submission state.StatusSubmission
	var words, findings []string
	var owner string
	prefixes := map[string]string{
		"--finding": "", "--finding-deferred": "deferred:", "--finding-anchor": "anchor:",
		"--reviewed": "reviewed:", "--stage-closed": "stage-closed:", "--stage-summary": "stage-summary:",
	}
	for i := 0; i < len(args); i++ {
		option := args[i]
		if option == "--next-stage" {
			findings = append(findings, "stage:next")
			continue
		}
		prefix, typed := prefixes[option]
		if typed || option == "--failure-owner" {
			i++
			if i == len(args) {
				return submission, fmt.Errorf("%s требует значение", option)
			}
			if typed {
				findings = append(findings, prefix+args[i])
			} else {
				owner = args[i]
			}
			continue
		}
		words = append(words, option)
	}
	if len(words) == 0 {
		return submission, fmt.Errorf("нужен результат done, skipped или failed")
	}
	submission.Result, submission.Comment = words[0], strings.Join(words[1:], " ")
	lead := os.Getenv("FACTORY_LOOP_ROLE") == "lead"
	verdict, err := state.EncodeRunVerdict(submission.Result, owner, findings, lead)
	submission.Verdict = verdict
	return submission, err
}

// readStatusCapability считывает закрытый обычный файл повторно с позиции 0.
// Значение никогда не передаётся в argv, окружение или диагностику.
func readStatusCapability(fd string) (string, error) {
	invalid := fmt.Errorf("неверный или отсутствующий дескриптор права запуска")
	original, err := strconv.Atoi(fd)
	if err != nil || original < 3 {
		return "", invalid
	}
	duplicate, err := syscall.Dup(original)
	if err != nil {
		return "", invalid
	}
	syscall.CloseOnExec(original)
	syscall.CloseOnExec(duplicate)
	file := os.NewFile(uintptr(duplicate), "status capability")
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 ||
		info.Size() < 2 || info.Size() > 4096 {
		return "", invalid
	}
	details, ok := info.Sys().(*syscall.Stat_t)
	if !ok || details.Nlink > 1 || details.Uid != uint32(os.Geteuid()) {
		return "", invalid
	}
	raw := make([]byte, info.Size())
	if n, err := file.ReadAt(raw, 0); (err != nil && !errors.Is(err, io.EOF)) || n != len(raw) {
		return "", invalid
	}
	token, present := strings.CutSuffix(string(raw), "\n")
	if !present || token == "" || strings.ContainsAny(token, "\n\r\x00") {
		return "", invalid
	}
	return token, nil
}

// verifyStatusPreflight передаёт ответ проверке профиля до публикации.
// Непригодный скрипт оставляет обязательную доверенную проверку принимающей стороне.
func verifyStatusPreflight(id state.RunIdentity, result string, diagnostic io.Writer) int {
	path := os.Getenv("FACTORY_STAGE_RESULT_CHECK")
	if result == "failed" || path == "" {
		return 0
	}
	info, err := os.Stat(path)
	if err != nil || !filepath.IsAbs(path) || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		fmt.Fprintln(diagnostic, "stage-result: предпроверка профиля недоступна")
		return 0
	}
	checked := host.RunProcess(context.Background(), host.Process{
		Path: path, Args: []string{id.Task, id.Stage, result}, Env: os.Environ(), Timeout: 30 * time.Second,
	})
	if checked.RC == 0 {
		return 0
	}
	fmt.Fprintf(diagnostic, "stage-result: сдача %s отклонена предпроверкой профиля (код %d)\n",
		result, checked.RC)
	fmt.Fprint(diagnostic, string(checked.Stdout), string(checked.Stderr))
	return 65
}
