// Команда готовит синтетические журналы для офлайн-тестов потребителей.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

type request struct {
	Root, Operation, Task, Profile, Route, Attempt, Node, Outcome string
	FailureOwner, Reason, Actor, Head                             string
	Sequence                                                      int64
	Verdict                                                       map[string]any
	SkipStage                                                     bool
}

func main() {
	var input request
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		exit(err)
	}
	store := state.Store{
		ControlDir: filepath.Join(input.Root, "control"),
		StateDir:   filepath.Join(input.Root, "state"),
	}
	result, err := execute(store, input)
	if err != nil {
		exit(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		exit(err)
	}
}

// execute записывает fixture через те же immutable writers, что использует движок.
// Настройки осознанно ограничены синтетическими каталогами теста.
func execute(store state.Store, input request) (any, error) {
	switch input.Operation {
	case "begin":
		attempt, _, err := store.BeginAttempt(state.BeginInput{
			Task: input.Task, Profile: input.Profile, RoutesDir: filepath.Join(input.Root, "routes"),
		})
		if err != nil {
			return nil, err
		}
		attempt, err = store.SelectRoute(input.Task, attempt.ID, input.Route)
		if err != nil {
			return nil, err
		}
		if !input.SkipStage {
			_, err = store.InitStage(input.Task, attempt.ID)
		}
		return attempt.ID, err
	case "init":
		return store.InitStage(input.Task, input.Attempt)
	case "pause":
		expected, err := store.ReadStage(input.Task, input.Attempt)
		if err != nil {
			return nil, err
		}
		return store.PauseStage(input.Task, input.Attempt, expected, input.Reason)
	case "bootstrap-stop":
		return seedBootstrapStop(store, input)
	case "commit":
		expected, err := store.ReadStage(input.Task, input.Attempt)
		if err != nil {
			return nil, err
		}
		return store.CommitStage(state.StageCommit{
			Task: input.Task, Attempt: input.Attempt, Node: input.Node, Outcome: input.Outcome,
			ExpectedHead: expected.HeadEventHash, ExpectedSequence: expected.Sequence,
			FailureOwner: input.FailureOwner, Verdict: input.Verdict,
		})
	case "rewind":
		return store.RewindStage(state.RewindRequest{
			Task: input.Task, Attempt: input.Attempt, Node: input.Node, Reason: input.Reason,
			Actor: input.Actor, ExpectedHead: input.Head, ExpectedSequence: input.Sequence,
		})
	default:
		return nil, fmt.Errorf("неизвестная операция fixture %q", input.Operation)
	}
}

// seedBootstrapStop сохраняет вопрос для пробы до открытия основного курсора.
// Хэш читается из опубликованного имени записи, которое проверяет сервер.
func seedBootstrapStop(store state.Store, input request) (any, error) {
	attempt, err := store.ReadAttempt(input.Task, input.Attempt)
	if err != nil {
		return nil, err
	}
	visit, _, err := store.BeginBootstrap(attempt)
	if err != nil {
		return nil, err
	}
	run := state.RunIdentity{
		Task: attempt.Task, Attempt: attempt.ID, Stage: "SCOUT", ID: "fixture-scout", Epoch: 1,
	}
	if err := store.StopBootstrap(attempt, visit, "exhausted", input.Reason,
		"", []state.BootstrapRun{{Run: run}}); err != nil {
		return nil, err
	}
	journal := filepath.Join(store.ControlDir, "protocol-v2/tasks", "t"+input.Task,
		"attempts", attempt.ID, "bootstrap-results")
	files, err := os.ReadDir(journal)
	if err != nil || len(files) != 2 {
		return nil, fmt.Errorf("неполный журнал разведки: %v", err)
	}
	parts := strings.Split(files[1].Name(), ".")
	if len(parts) != 4 {
		return nil, fmt.Errorf("неверное имя события разведки")
	}
	return map[string]string{"visit": visit, "stopHash": parts[2]}, nil
}

func exit(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
