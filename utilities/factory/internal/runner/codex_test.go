package runner

import (
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCodexSharedStand(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux permission profile")
	}
	run := adapterFixture(t)
	root := run.Worktree
	broker := filepath.Join(root, "agent-control")
	run.Worktree = filepath.Join(root, "checkout")
	for _, dir := range []string{run.Worktree, broker} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	run.CodexShared = &CodexSharedAccess{BrokerDir: broker}
	installation := filepath.Join(root, "codex-install")
	entry := filepath.Join(installation, "bin")
	arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[runtime.GOARCH]
	native := filepath.Join(installation, "node_modules/@openai/codex-linux-fixture/vendor", arch, "bin")
	for _, dir := range []string{entry, native} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Link(run.Factory, filepath.Join(native, "codex")); err != nil {
		t.Fatal(err)
	}
	binary := fakeRunnerCLI(t, entry, "codex", submitFixtureResult)
	policy := routePolicy{filesystem: "workspace-write", shared: true}
	out, err := runCodexAdapter(run, binary, "тест", policy)
	if err != nil || out.Terminal.Result != "done" {
		t.Fatalf("ограниченный stand: outcome=%+v, error=%v", out, err)
	}
	args := checkFixtureFile(t, binary+".calls", "--ignore-user-config\n", "--strict-config\n",
		`approval_policy="never"`, `network = { enabled = false }`, `"`+broker+`" = "read"`,
		`".git" = "read"`, `".codex" = "read"`, "hooks.PreToolUse")
	for _, forbidden := range []string{
		"--approve-for-me", "--sandbox\n", "sandbox_workspace_write.network_access",
	} {
		if strings.Contains(args, forbidden) {
			t.Fatalf("лишний argv %q", forbidden)
		}
	}
	run.Binary = binary
	for _, access := range []*CodexSharedAccess{
		nil,
		{BrokerDir: broker, ReadDirs: []string{root}},
		{BrokerDir: broker, WriteDirs: []string{broker}},
		{BrokerDir: run.Store.ControlDir},
	} {
		unsafe := run
		unsafe.CodexShared = access
		if _, _, err := codexArgs(unsafe, policy); err == nil || err.Code != 4 {
			t.Fatalf("небезопасный набор корней допущен: %+v, отказ %v", access, err)
		}
	}
	t.Run("native", func(t *testing.T) {
		binary := os.Getenv("FACTORY_TEST_CODEX_BIN")
		if binary == "" {
			t.Skip("нужен проверенный нативный Codex")
		}
		run.Binary = binary
		verifyCodexSandbox(t, run, routePolicy{filesystem: "state-only", shared: true})
	})
}

// verifyCodexSandbox использует нативный sandbox с конфигурацией Go-адаптера.
// Модель не вызывается. Приватный /tmp существует только внутри mount namespace теста.
func verifyCodexSandbox(t *testing.T, run Run, policy routePolicy) {
	t.Helper()
	root := filepath.Dir(run.Worktree)
	if strings.HasPrefix(root, "/tmp/") {
		t.Fatal("тест должен находиться вне монтируемого /tmp")
	}
	for _, dir := range []string{"tmp", "codex-home", "state/.git", "state/.codex"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []string{"agent-control/data", "control/private", "checkout/source"} {
		if err := os.WriteFile(filepath.Join(root, file), []byte("canary\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			_, _ = io.WriteString(connection, "canary\n")
			_ = connection.Close()
		}
	}()
	args, cwd, refusal := codexArgs(run, policy)
	if refusal != nil {
		t.Fatal(refusal)
	}
	var config []string
	for i, arg := range args {
		if arg == "-c" {
			config = append(config, arg, args[i+1])
		}
	}
	probe := `
set -eu
mount --bind "$1/tmp" /tmp
root=$1 factory=$2 port=$3 binary=$4
shift 4
[[ $(cat <"/dev/tcp/127.0.0.1/$port") == canary ]]
"$binary" "$@" sandbox -- /bin/bash -ec '
  printf "state\n" > result
  [[ $(cat "$1/agent-control/data") == canary ]]
  if (printf no > "$1/agent-control/write"); then exit 41; fi
  if (printf no > .git/write); then exit 42; fi
  if (printf no > .codex/write); then exit 43; fi
  if cat "$1/control/private"; then exit 44; fi
  [[ $(cat "$1/checkout/source") == canary ]]
  if (printf no > "$1/checkout/source"); then exit 45; fi
  if cat <"/dev/tcp/127.0.0.1/$3"; then exit 46; fi
  printf "%s\n" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"docker ps\"}}" |
    "$2" _factory-codex-policy | grep -F "\"permissionDecision\":\"deny\""
' bash "$root" "$factory" "$port"
`
	port := strings.Split(listener.Addr().String(), ":")[1]
	launch := []string{"--user", "--map-root-user", "--mount", "--propagation", "private",
		"/bin/bash", "-c", probe, "bash", root, run.Factory, port, run.Binary}
	child := exec.CommandContext(t.Context(), "unshare", append(launch, config...)...)
	child.Dir = cwd
	child.Env = []string{
		"PATH=" + os.Getenv("PATH"), "HOME=" + root, "CODEX_HOME=" + filepath.Join(root, "codex-home"),
	}
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("нативная граница Codex: %v\n%s", err, output)
	} else {
		t.Logf("нативная граница Codex:\n%s", output)
	}
}

func TestCodexIsolatedStateOnly(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux permission profile")
	}
	run := adapterFixture(t)
	root := run.Worktree
	run.Worktree = filepath.Join(root, "checkout")
	for _, dir := range []string{run.Worktree, filepath.Join(root, "tmp"), filepath.Join(root, "codex-home")} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"checkout/source", "control/private"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("canary\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	policy := routePolicy{filesystem: "state-only", addDirs: []string{run.Worktree}}
	args, cwd, refusal := codexArgs(run, policy)
	if refusal != nil || cwd != run.Store.StateDir {
		t.Fatalf("state-only: cwd=%q, ошибка=%v", cwd, refusal)
	}
	argv := strings.Join(args, "\n")
	for _, expected := range []string{
		`approval_policy="never"`, `default_permissions="factory-state-only"`,
		`"` + run.Store.StateDir + `" = "write"`, `"` + run.Store.ControlDir + `" = "none"`,
	} {
		if !strings.Contains(argv, expected) {
			t.Fatalf("аргументы Codex без %q: %s", expected, argv)
		}
	}
	for _, forbidden := range []string{"--approve-for-me", "--sandbox", "--add-dir"} {
		if strings.Contains(argv, forbidden) {
			t.Fatalf("лишний аргумент %q", forbidden)
		}
	}
	overlap := run
	overlap.Worktree = root
	if _, _, refusal := codexArgs(overlap, policy); refusal == nil {
		t.Fatal("каталог состояния внутри checkout получил разрешение записи")
	}

	t.Run("native", func(t *testing.T) {
		binary := os.Getenv("FACTORY_TEST_CODEX_BIN")
		if binary == "" {
			t.Skip("нужен проверенный нативный Codex")
		}
		if strings.HasPrefix(root, "/tmp/") {
			t.Fatal("тест должен находиться вне монтируемого /tmp")
		}
		env, _, err := run.statusEnvironment("codex", true)
		if err != nil {
			t.Fatal(err)
		}
		probe := `
mount --bind "$1/tmp" /tmp
root=$1 binary=$2
shift 2
exec "$binary" "$@" sandbox -- /bin/bash -ec '
  printf "state\n" > plan.md
  [[ $(cat "$1/checkout/source") == canary ]]
  if (printf no > "$1/checkout/source"); then exit 41; fi
  if cat "$1/control/private"; then exit 42; fi
  ` + submitFixtureResult + `
' bash "$root"
`
		launch := []string{"--user", "--map-root-user", "--mount", "--propagation", "private",
			"/bin/bash", "-ec", probe, "bash", root, binary}
		for i, arg := range args {
			if arg == "-c" {
				launch = append(launch, arg, args[i+1])
			}
		}
		child := exec.CommandContext(t.Context(), "unshare", launch...)
		child.Dir = cwd
		child.Env = append(env, "CODEX_HOME="+filepath.Join(root, "codex-home"))
		if output, err := child.CombinedOutput(); err != nil {
			t.Fatalf("нативная граница Codex: %v\n%s", err, output)
		}
		checkFixtureFile(t, filepath.Join(cwd, "plan.md"), "state\n")
		if rc, err := run.Store.ConsumeStatusRequests(run.Identity, run.Capability); rc != 0 || err != nil {
			t.Fatalf("очередь stage-result, код %d: %v", rc, err)
		}
		if result, rc, err := run.Store.ReadRun(run.Identity); result.Result != "done" || rc != 0 || err != nil {
			t.Fatalf("результат %q, код %d: %v", result.Result, rc, err)
		}
	})
}

func TestCodexAdapterOffline(t *testing.T) {
	policy := routePolicy{filesystem: "workspace-write", sandbox: "workspace-write"}
	t.Run("argv-and-usage", func(t *testing.T) {
		run := adapterFixture(t)
		usage := `{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":7,` +
			`"cached_input_tokens":3,"cache_write_input_tokens":1}}`
		body := "printf '%s\\n' " + shellQuote(usage) + "\n" + submitFixtureResult
		binary := fakeRunnerCLI(t, run.Worktree, "codex", body)
		out, err := runCodexAdapter(run, binary, "канарейка промпта", policy)
		if err != nil || out.Classification != "ok" || out.Terminal.Result != "done" {
			t.Fatalf("исход: %+v %v", out, err)
		}
		log := filepath.Join(run.Worktree, "codex.calls")
		argv := checkFixtureFile(t, log, "exec\n--json\n--skip-git-repo-check\n", "--approve-for-me\n")
		for _, forbidden := range []string{"--sandbox", "--yolo", "danger-full-access", "канарейка промпта"} {
			if strings.Contains(argv, forbidden) {
				t.Fatalf("лишний argv %q", forbidden)
			}
		}
		checkFixtureFile(t, log+".stdin", "канарейка промпта")
		checkFixtureFile(t, filepath.Join(run.Dir, "meta.env"), "SOURCE=runtime\n")
		if out.Usage.InputTokens != 11 || out.Usage.OutputTokens != 7 ||
			out.Usage.CachedInputTokens != 3 || out.Usage.CacheWriteInputTokens != 1 {
			t.Fatalf("usage: %+v", out.Usage)
		}
	})
	t.Run("no-result", func(t *testing.T) {
		run := adapterFixture(t)
		binary := fakeRunnerCLI(t, run.Worktree, "codex", "")
		_, err := runCodexAdapter(run, binary, "промпт", policy)
		if err == nil || err.Code != 76 {
			t.Fatalf("отсутствующий stage-result: %v", err)
		}
	})
	for _, name := range []string{"quota", "http-429"} {
		t.Run(name, func(t *testing.T) {
			run := adapterFixture(t)
			event, expected := `{"type":"usage_limit_reached"}`, "limited"
			if name == "http-429" {
				event, expected = `{"type":"error","status":429,"message":"too many requests"}`, "transient"
			}
			body := "printf '%s\\n' " + shellQuote(event) + "\n" +
				"printf 'try again at 2027-01-02 03:04\\n' >&2"
			binary := fakeRunnerCLI(t, run.Worktree, "codex", body)
			file := filepath.Join(run.Worktree, "codex.calls.rc")
			if err := os.WriteFile(file, []byte("4\n"), 0600); err != nil {
				t.Fatal(err)
			}
			out, _ := runCodexAdapter(run, binary, "промпт", policy)
			if out.Classification != expected || (name == "quota" && out.LimitUntil == "") {
				t.Fatalf("лимит: %+v", out)
			}
			checkFixtureFile(t, filepath.Join(run.Dir, "stderr.log"), "try again at 2027")
		})
	}
}

func TestCodexBrowserRequest(t *testing.T) {
	paths := []string{"/usr/bin/node", "/test/factory-browser.mjs"}
	request := quoteBrowserPath(paths[0]) + " " + quoteBrowserPath(paths[1]) + " request --input-json " +
		quoteBrowserPath(`{"action":"fill","text":"git push и одинарная 'кавычка'"}`)
	if !fixedCodexBrowserRequest(request, paths) {
		t.Fatal("литеральный JSON отклонён")
	}
	for _, command := range []string{
		request + "; git push", request + " && echo extra",
		strings.Replace(request, paths[1], "/test/other-helper.mjs", 1),
	} {
		if fixedCodexBrowserRequest(command, paths) {
			t.Fatalf("лишняя команда принята: %q", command)
		}
	}
}
