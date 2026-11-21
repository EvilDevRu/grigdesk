package hooks

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestCommandHook(t *testing.T) {
	root := fixtureWorkingDirectory(t)
	contextFile := filepath.Join(root, "контекст $ узла.json")
	if err := os.WriteFile(contextFile, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	arguments := CommandInput{
		Task: "71", Route: "health-check", Node: "verify", RunKey: "VERIFY",
		CommandID: "verify-source", ContextFile: contextFile,
	}
	base := `
profile_route_command() {
  [[ $# -eq 6 ]] || return 64
  printf '%s\0' "$@" >"$TEST_ROOT/argv"
  printf '%s\n' "$PWD" >"$TEST_ROOT/cwd"
  printf '%s\n' "$VERDICT_JSON"
}

return 64
`
	valid := `{"schema":1,"outcome":"done","comment":"готово","failureOwner":null,"findings":[]}`

	t.Run("early_source_return_after_definition", func(t *testing.T) {
		env := []string{"VERDICT_JSON=" + valid}
		invocation := fixtureInvocation(t, root, base, env)
		result, rc, err := RunCommand(t.Context(), invocation, arguments)
		if rc != 0 || err != nil || result.Outcome != "done" || result.Comment != "готово" {
			t.Fatalf("command rc=%d verdict=%+v error=%v", rc, result, err)
		}
		want := []string{"71", "health-check", "verify", "VERIFY", "verify-source", contextFile, ""}
		got := strings.Split(string(readHookFixture(t, filepath.Join(root, "argv"))), "\x00")
		if !slices.Equal(got, want) {
			t.Fatalf("argv=%q, ожидалось %q", got, want)
		}
		if got := string(readHookFixture(t, filepath.Join(root, "cwd"))); got != root+"\n" {
			t.Fatalf("cwd=%q, ожидалось %q", got, root)
		}
	})

	t.Run("source_return_before_definition", func(t *testing.T) {
		invocation := fixtureInvocation(t, root, "return 64\n"+base, nil)
		_, rc, err := RunCommand(t.Context(), invocation, arguments)
		if rc != 78 || err == nil || !strings.Contains(err.Error(), "profile_route_command") {
			t.Fatalf("rc=%d, ожидался отказ по отсутствующему хуку, ошибка=%v", rc, err)
		}
	})

	cases := []struct {
		name    string
		payload string
		rc      int
	}{
		{"two_objects", valid + "\n" + valid, 78},
		{"repeated_id", `{"schema":1,"outcome":"failed","comment":"отказ","failureOwner":"build",
		   "findings":[{"id":"same","summary":"первый"},{"id":"same","summary":"второй"}]}`, 78},
		{"invalid_owner", `{"schema":1,"outcome":"failed","comment":"отказ","failureOwner":"reviewer",
		   "findings":[{"id":"one","summary":"замечание"}]}`, 78},
		{"non_object", `"строка"`, 78},
		{"deferred_done", `{"schema":1,"outcome":"done","comment":"готово","failureOwner":null,
		   "findings":[{"id":"one","summary":"замечание","severity":"deferred"}]}`, 0},
		{"findings_skipped", `{"schema":1,"outcome":"skipped","comment":"пропуск","failureOwner":null,
		   "findings":[{"id":"one","summary":"замечание","severity":"deferred"}]}`, 78},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			invocation := fixtureInvocation(t, root, base, []string{"VERDICT_JSON=" + item.payload})
			result, rc, err := RunCommand(t.Context(), invocation, arguments)
			if rc != item.rc || (err != nil) != (item.rc != 0) {
				t.Fatalf("rc=%d, ожидался %d, ошибка=%v", rc, item.rc, err)
			}
			if item.name == "deferred_done" &&
				(len(result.Findings) != 1 || result.Findings[0].Severity != "deferred") {
				t.Fatalf("отложенная находка потеряна: %+v", result)
			}
		})
	}
}

func TestAgentControlBridge(t *testing.T) {
	root := fixtureWorkingDirectory(t)
	profile := `
profile_agent_control_start() {
  fixture_shell=$BASHPID
  printf 'start %s %s\n' "$@" >"$TEST_ROOT/events"
  PROFILE_AGENT_CONTROL_DIR="$TEST_ROOT/broker"
  mkdir -m 700 -- "$PROFILE_AGENT_CONTROL_DIR"
  printf 'диагностика старта\n'
}
profile_agent_control_stop() {
  [[ "$fixture_shell" == "$BASHPID" ]] || return 99
  printf 'stop %s %s %s\n' "$@" >>"$TEST_ROOT/events"
  rmdir -- "$PROFILE_AGENT_CONTROL_DIR"
}
`
	invocation := fixtureInvocation(t, root, profile, nil)
	result := runBridge(t.Context(), invocation, "agent-control", "71", "VERIFY")
	if result.RC != 0 || string(result.Stdout) != "ready\t"+filepath.Join(root, "broker")+"\n" {
		t.Fatalf("канал не открыт: rc=%d stdout=%q stderr=%q", result.RC, result.Stdout, result.Stderr)
	}
	want := "start 71 VERIFY\nstop 71 VERIFY 130\n"
	if events := string(readHookFixture(t, filepath.Join(root, "events"))); events != want {
		t.Fatalf("жизненный цикл при EOF: %q, ожидался %q", events, want)
	}
	t.Run("пара_обязательна", func(t *testing.T) {
		partial := `profile_agent_control_start() { touch "$TEST_ROOT/effect"; }`
		invocation := fixtureInvocation(t, root, partial, nil)
		control, err := OpenAgentControl(t.Context(), invocation, "71", "VERIFY")
		if control != nil || err == nil || !strings.Contains(err.Error(), "profile_agent_control_stop") {
			t.Fatalf("неполная пара: канал=%v, ошибка=%v", control, err)
		}
		if _, err := os.Stat(filepath.Join(root, "effect")); !os.IsNotExist(err) {
			t.Fatalf("неполная пара вызвала start: %v", err)
		}
	})
	t.Run("публичный_каталог_отклонён", func(t *testing.T) {
		public := strings.Replace(profile, "mkdir -m 700", "mkdir -m 755", 1)
		invocation := fixtureInvocation(t, root, public, nil)
		control, err := OpenAgentControl(t.Context(), invocation, "71", "VERIFY")
		if control != nil || err == nil {
			t.Fatalf("публичный каталог: канал=%v, ошибка=%v", control, err)
		}
		if events := string(readHookFixture(t, filepath.Join(root, "events"))); events != "start 71 VERIFY\nstop 71 VERIFY 78\n" {
			t.Fatalf("недопущенный канал не закрыт: %q", events)
		}
	})

	t.Run("корни_из_профиля", func(t *testing.T) {
		config := `
RUNNER_CODEX_RESTRICT_SHARED_STAND=1
RUNNER_CODEX_READ_DIRS=/opt/fixture-read
PROFILE_AGENT_DIRS=/opt/fixture-write
`
		invocation := fixtureInvocation(t, root, config+profile, []string{"RUNNER_CODEX_READ_DIRS=/host/ignored"})
		control, err := OpenAgentControl(t.Context(), invocation, "71", "VERIFY")
		if err != nil || control == nil {
			t.Fatalf("ограниченный канал: %v", err)
		}
		if err := control.Close(0); err != nil {
			t.Fatal(err)
		}
		if !control.Codex || !slices.Equal(control.ReadDirs, []string{"/opt/fixture-read"}) ||
			!slices.Equal(control.WriteDirs, []string{"/opt/fixture-write"}) {
			t.Fatalf("неверные корни: %+v", control)
		}
	})
}

func TestAgentRules(t *testing.T) {
	root := fixtureWorkingDirectory(t)
	profile := `
PROFILE_AGENT_ALLOW=('Bash(make test:*)')
PROFILE_AGENT_DENY=('Bash(git push:*)')
profile_stage_agent_allow() {
  [[ "$1" == VERIFY ]] || return 78
  printf '%s\n' 'Bash(./verify.sh:*)'
}
`
	invocation := fixtureInvocation(t, root, profile, nil)
	rules, err := ReadAgentRules(t.Context(), invocation, "VERIFY")
	if err != nil || !slices.Equal(rules.Allow, []string{"Bash(make test:*)", "Bash(./verify.sh:*)"}) ||
		!slices.Equal(rules.Deny, []string{"Bash(git push:*)"}) {
		t.Fatalf("правила проверки: %+v, %v", rules, err)
	}
	if _, err := ReadAgentRules(t.Context(), invocation, "SHIP"); err == nil {
		t.Fatal("потерян отказ profile_stage_agent_allow")
	}
}

func TestStandOwnership(t *testing.T) {
	t.Run("workspace_then_stand", func(t *testing.T) {
		stand, root := standFixture(t, "0")
		events := filepath.Join(root, "events")
		stand.EarlyReady = func(data []byte) error {
			if string(data) != "TASK=71\nWORKSPACE_MODE=isolated\nSTAND_OWNERSHIP=task\n" {
				return errors.New("неверный ранний descriptor")
			}
			if _, err := os.Stat(stand.StateFile); !os.IsNotExist(err) {
				return errors.New("стенд готов раньше рабочего дерева")
			}
			contents := append(readHookFixture(t, events), []byte("workspace-ready\n")...)
			return os.WriteFile(events, contents, 0600)
		}
		rc, err := PrepareStand(t.Context(), stand)
		if rc != 0 || err != nil {
			t.Fatalf("rc=%d, ошибка=%v", rc, err)
		}
		want := "up\nworkspace-ready\nstand-ready\nhealth\n"
		if events := string(readHookFixture(t, events)); events != want {
			t.Fatalf("события=%q, ожидались %q", events, want)
		}
		rc, err = PrepareStand(t.Context(), stand)
		if rc != 0 || err != nil {
			t.Fatalf("health существующего стенда: rc=%d ошибка=%v", rc, err)
		}
		if events := string(readHookFixture(t, events)); events != want+"health\n" {
			t.Fatalf("при resume повторилась подготовка: %q", events)
		}
		rc, err = CleanupStand(t.Context(), stand)
		if rc != 0 || err != nil {
			t.Fatalf("очистка принадлежащего стенда: rc=%d ошибка=%v", rc, err)
		}
		if events := string(readHookFixture(t, events)); events != want+"health\ndown\n" {
			t.Fatalf("хук очистки затронул другой ресурс: %q", events)
		}
	})

	t.Run("up_failure_after_workspace", func(t *testing.T) {
		stand, root := standFixture(t, "42")
		stand.EarlyReady = func([]byte) error {
			return os.WriteFile(filepath.Join(root, "events"), []byte("up\nworkspace-ready\n"), 0600)
		}
		rc, err := PrepareStand(t.Context(), stand)
		if rc != 42 || err == nil {
			t.Fatalf("ошибка после рабочего дерева: rc=%d ошибка=%v", rc, err)
		}
		rc, err = PrepareStand(t.Context(), stand)
		if rc == 0 || err == nil {
			t.Fatalf("частичный up нельзя запускать повторно: rc=%d ошибка=%v", rc, err)
		}
		events := string(readHookFixture(t, filepath.Join(root, "events")))
		if events != "up\nworkspace-ready\n" {
			t.Fatalf("повтор подъёма или health после ошибки: %q", events)
		}
	})

	t.Run("foreign_shared", func(t *testing.T) {
		stand, root := standFixture(t, "0")
		stand.Mode, stand.Owner = "shared", "other-task"
		rc, err := PrepareStand(t.Context(), stand)
		if rc != 75 || err == nil {
			t.Fatalf("чужая shared аренда должна вернуть конфликт: rc=%d ошибка=%v", rc, err)
		}
		if _, err := os.Stat(filepath.Join(root, "events")); !os.IsNotExist(err) {
			t.Fatalf("хук чужого стенда был вызван: %v", err)
		}
	})
}

// fixtureWorkingDirectory выделяет физический тестовый cwd с пробелом.
// Все процессы хука получают пути только внутри этого каталога.
func fixtureWorkingDirectory(t *testing.T) string {
	t.Helper()
	physical, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(physical, "profile space")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	return root
}

// fixtureInvocation указывает разрешённые пути и окружение тестового хука.
// Базовый env не содержит ключей, токенов или провайдерных настроек.
func fixtureInvocation(t *testing.T, root, profile string, vars []string) Invocation {
	t.Helper()
	path := filepath.Join(root, "profile.sh")
	if err := os.WriteFile(path, []byte(profile), 0600); err != nil {
		t.Fatal(err)
	}
	env := append([]string{"PATH=/usr/bin:/bin", "HOME=" + root, "TEST_ROOT=" + root}, vars...)
	return Invocation{Profile: path, Directory: root, Env: env, Timeout: 3 * time.Second}
}

// readHookFixture читает только явный артефакт внутри тестового каталога.
// Отсутствие файла означает, что проверяемый эффект не выполнился.
func readHookFixture(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// standFixture имитирует два момента готовности и обязательный health.
// Барьер открывает движок через callback только после раннего descriptor.
func standFixture(t *testing.T, exitCode string) (StandRequest, string) {
	t.Helper()
	root := fixtureWorkingDirectory(t)
	early, final := filepath.Join(root, "early.env"), filepath.Join(root, "t71.env")
	profile := `
profile_workspace_mode() { printf 'isolated\n'; }
profile_stand_alive() {
  printf 'health\n' >>"$TEST_ROOT/events"
  [[ -f "$STATE_FILE" ]]
}
`
	up := `#!/usr/bin/env bash
set -euo pipefail
printf 'up\n' >>"$TEST_ROOT/events"
printf 'TASK=%s\nWORKSPACE_MODE=isolated\nSTAND_OWNERSHIP=task\n' "$1" >"$FACTORY_BOOTSTRAP_WORKSPACE_ENV.tmp"
mv "$FACTORY_BOOTSTRAP_WORKSPACE_ENV.tmp" "$FACTORY_BOOTSTRAP_WORKSPACE_ENV"
while ! grep -q '^workspace-ready$' "$TEST_ROOT/events"; do sleep 0.01; done
if [[ "$FIXTURE_EXIT" != 0 ]]; then exit "$FIXTURE_EXIT"; fi
cp "$FACTORY_BOOTSTRAP_WORKSPACE_ENV" "$STATE_FILE"
printf 'stand-ready\n' >>"$TEST_ROOT/events"
`
	if err := os.WriteFile(filepath.Join(root, "up.sh"), []byte(up), 0700); err != nil {
		t.Fatal(err)
	}
	down := `
set -euo pipefail
[[ "$1" == 71 ]]
printf 'down\n' >>"$TEST_ROOT/events"
rm -- "$STATE_FILE"
`
	if err := os.WriteFile(filepath.Join(root, "down.sh"), []byte(down), 0700); err != nil {
		t.Fatal(err)
	}
	env := []string{"STATE_FILE=" + final, "FIXTURE_EXIT=" + exitCode}
	invocation := fixtureInvocation(t, root, profile, env)
	return StandRequest{Invocation: invocation, Task: "71", Mode: "isolated", Owner: "task",
		StateFile: final, EarlyFile: early}, root
}
