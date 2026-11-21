package engine_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

const testTask = "7101"

func TestRunCommandToGate(t *testing.T) {
	f := newRouteFixture(t, false)
	f.expectStart(t, false)
	f.assertGate(t)
}

// TestWindowsResumeAtGate продолжает ту же попытку отдельным процессом фабрики.
// Доверенное состояние ворот и результат сверяются после повторного открытия.
func TestWindowsResumeAtGate(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("проверка относится к нативной Windows")
	}
	f := newRouteFixture(t, false)
	f.expectStart(t, false)
	f.assertGate(t)
	id := f.attempt(t)
	if rc, out := f.run(t, "resume", "--attempt", id); rc != 0 {
		t.Fatalf("resume rc=%d: %s", rc, out)
	}
	f.assertGate(t)
	if f.attempt(t) != id {
		t.Fatal("resume заменил ID попытки")
	}
}

func TestHoldStart(t *testing.T) {
	f := newRouteFixture(t, false)
	f.reserveRuntime(t)
	f.expectStart(t, true)
	id := f.attempt(t)
	f.assertBound(t, id)
	f.expectCount(t, "command", "")
	f.expectCount(t, "runner", "")
	if _, err := f.store.ReadStage(testTask, id); !errors.Is(err, state.ErrStageAbsent) {
		t.Fatalf("held start создал cursor: %v", err)
	}
	if f.projection(t)["HELD_START"] != "1" {
		t.Fatal("held start не подтверждён")
	}
	revised := f.publish(t, f.catalog, "Новый заголовок")
	if revised == f.catalog {
		t.Fatal("фикстура не сменила current")
	}
	if rc, out := f.run(t, "resume", "--attempt", id); rc != 0 {
		t.Fatalf("resume rc=%d: %s", rc, out)
	}
	f.assertGate(t)
	attempt, err := f.store.ReadAttempt(testTask, id)
	if err != nil || attempt.CatalogHash != f.catalog {
		t.Fatalf("подменён pin: %+v, %v", attempt, err)
	}
}

func TestGuardRollback(t *testing.T) {
	f := newRouteFixture(t, true)
	rc, output := f.start(t, false)
	if rc != 75 || !strings.Contains(output, "workspace guard") {
		t.Fatalf("workspace guard rc=%d: %s", rc, output)
	}
	f.expectCount(t, "command", "1\n")
	f.expectCount(t, "runner", "")
	stage, err := f.store.ReadStage(testTask, f.attempt(t))
	if err != nil || stage.Sequence != 0 || stage.CurrentNode != "verify" {
		t.Fatalf("изменён авторитетный cursor: %+v %v", stage, err)
	}
	f.readEqual(t, filepath.Join(f.checkout, "scope.txt"), "changed\n")
	f.readEqual(t, filepath.Join(f.checkout, "outside.txt"), "outside\n")
}

type routeFixture struct {
	dir, repo, checkout, routes, profile, binary, catalog string
	store                                                 state.Store
	runtimeEnv                                            []string
	extraEnv                                              []string
}

// newRouteFixture собирает одно новое исполняемое приложение и отдельные физические корни.
// Профиль содержит только детерминированные хуки, провайдер отсутствует.
func newRouteFixture(t *testing.T, damage bool) routeFixture {
	t.Helper()
	repo, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := routeFixture{
		dir: dir, repo: repo, checkout: filepath.Join(dir, "checkout"), routes: filepath.Join(dir, "routes"),
		profile: filepath.Join(dir, "profiles", "demo-profile"), binary: filepath.Join(dir, "factory"),
		store: state.Store{StateDir: filepath.Join(dir, "state"), ControlDir: filepath.Join(dir, "control")},
	}
	if runtime.GOOS == "windows" {
		f.binary += ".exe"
		f.extraEnv = []string{"FACTORY_WINDOWS_BASH=" + os.Getenv("FACTORY_WINDOWS_BASH")}
	}
	for _, directory := range []string{f.profile, f.checkout, f.store.StateDir} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	f.runFixture(t, "git", "-C", f.checkout, "init", "-qb", "shared-main")
	f.write(t, filepath.Join(f.checkout, "scope.txt"), "baseline\n")
	f.write(t, filepath.Join(f.checkout, "outside.txt"), "outside\n")
	profile := `
PROFILE_NAME=demo-profile
PROFILE_SERVICE_HOST=127.0.0.1
profile_workspace_mode() { printf 'shared\n'; }
profile_repositories() { printf 'app\t%s\t%s\n' "$FIXTURE_CHECKOUT" "$FIXTURE_CHECKOUT"; }
profile_source_branch() { printf 'shared-main\n'; }
profile_container() { printf 'fixture-stand\n'; }
profile_stand_alive() { return 0; }
profile_project_context() { printf '%s\n' '{"stack":["fixture"],"guardrails":[]}'; }
profile_service_ports() { printf '8830\t8830\n'; }
profile_exclusive_resources() { printf '%s\n' 'stand:fixture-stand' "workspace:$FIXTURE_CHECKOUT"; }
profile_instrumentation_restored() { return 0; }
profile_route_command() {
  [[ "$1:$2:$3:$4:$5" == '7101:command:verify:VERIFY:fixture-verify' && -r "$6" ]] || return 91
  printf '1\n' >>"$FIXTURE_ROOT/command.count"
  DAMAGE_LINE
  printf '%s\n' '{"schema":1,"outcome":"done","comment":"fixture","failureOwner":null,"findings":[]}'
}
`
	line := ":"
	if damage {
		line = `printf 'changed\n' >"$FIXTURE_CHECKOUT/scope.txt"`
	}
	f.write(t, filepath.Join(f.profile, "profile.sh"), strings.Replace(profile, "DAMAGE_LINE", line, 1))
	f.write(t, filepath.Join(f.profile, "graph.json"), `{"capabilities":["route-v2"]}`)
	f.write(t, filepath.Join(f.profile, "runners.env"), "RUNNERS_SCHEMA=1\nCONFIG_REVISION=1\n"+
		"RUNNERS_COVERAGE=required\nPROJECT_RUNNER_PRIMARY=deepseek\nPROJECT_RUNNER_FAILOVER=\n")
	f.write(t, filepath.Join(dir, "command.count"), "")
	f.write(t, filepath.Join(dir, "runner.count"), "")
	f.write(t, filepath.Join(dir, "ticket.json"), `{"schema":1,"taskId":"7101","title":"Fixture",`+
		`"description":"Проверка","acceptanceCriteria":["ворота"],"sourceUrl":"https://example.test/7101"}`)
	f.catalog = f.publish(t, "", "Исходный маршрут")
	build := []string{
		"-C", repo, "build", "-trimpath", "-o", f.binary, "./utilities/factory/cmd/factory",
	}
	f.runFixture(t, "go", build...)
	binary, err := os.ReadFile(f.binary)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("factory %s SHA256=%x", f.binary, sha256.Sum256(binary))
	return f
}

// publish переиспользует production RoutesStore и существующий DTO command.
// У маршрута два узла, поэтому он доходит до ворот без тестового провайдера.
func (f routeFixture) publish(t *testing.T, expected, title string) string {
	t.Helper()
	if runtime.GOOS == "windows" && expected == "" {
		t.Setenv("GRIGDESK_FACTORY_BIN", f.binary)
		fixture := os.DirFS(filepath.Join(f.repo, ".github", "fixtures", "windows-native-routes"))
		if err := os.CopyFS(f.routes, fixture); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(f.routes, "demo-profile", "catalog", "current.json"))
		var pointer struct{ CatalogHash string }
		if err != nil || json.Unmarshal(data, &pointer) != nil || pointer.CatalogHash == "" {
			t.Fatalf("повреждён каталог тестовой фикстуры: %s, %v", data, err)
		}
		return pointer.CatalogHash
	}
	return f.publishBootstrap(t, expected, title, "skip")
}

// publishBootstrap задаёт режим разведки, сохраняя тот же основной маршрут.
// Обе версии проходят проверку настоящим издателем маршрутов.
func (f routeFixture) publishBootstrap(t *testing.T, expected, title, mode string) string {
	t.Helper()
	return f.publishRoute(t, expected, title, mode, "")
}

// publishRoute публикует командный маршрут либо пару инструментирования и замера.
// Обе фикстуры используют действующий publisher GrigDesk.
func (f routeFixture) publishRoute(t *testing.T, expected, title, mode, transaction string) string {
	t.Helper()
	script := `
import { pathToFileURL } from 'node:url';
const [repo, routes, expected, title, mode, transaction] = process.argv.slice(1);
const { RoutesStore } = await import(pathToFileURL(repo + '/server/src/modules/routes/store.ts'));
const base = await import(pathToFileURL(repo + '/tests/engine/fixtures/routes-catalog-definitions.mjs'));
const definitions = base.ROUTE_DEFINITIONS.command.route.nodes;
const verify = structuredClone(definitions.find((node) => node.id === 'verify'));
const stop = {stop:'human'};
verify.on = {done:{next:'gate_accept'}, skipped:stop, failed:stop, exhausted:stop};
delete verify.onFailure;
const gate = {
  id:'gate_accept', executor:'gate', phase:'main', runKey:'GATE_ACCEPT', emits:[],
  on:{approved:{stop:'done'}, rejected:stop},
};
const route = {
  ...base.ROUTE_DEFINITIONS.command.route, title, bootstrap:mode, entry:'verify',
  sequence:{main:['verify','gate_accept'],tail:[]}, nodes:[verify, gate],
};
const prompts = {};
if (transaction) {
  const reference = base.ROUTE_DEFINITIONS.debug.route.nodes.find((item) => item.id === 'instrument');
  const agent = (id, runKey, done) => ({
    ...structuredClone(reference), id, runKey, phase:'main',
    prompt:{blocks:[{file:'prompts/instrument.base.md'}], requiredContext:['task','instrumentation']},
    on:{done, skipped:stop, failed:stop, exhausted:stop},
  });
  const instrument = agent('instrument','INSTRUMENT',{next:'proof'});
  const proof = agent('proof','PROOF',{next:'gate_accept'});
  route.entry = 'instrument';
  route.nodes = [instrument, proof, gate];
  route.sequence.main = ['instrument', 'proof', 'gate_accept'];
  if (transaction === 'zone') {
    instrument.on.done = {next:'verify'};
    verify.on.done = {next:'proof'};
    route.nodes.splice(1, 0, verify);
    route.sequence.main.splice(1, 0, 'verify');
  }
  prompts['prompts/instrument.base.md'] = 'Фикстура инструментации.';
}
const store = new RoutesStore({baseDir:routes});
const published = await store.publishRoute(base.PROFILE_ID,'command',{route,prompts});
const scout = structuredClone(base.bootstrap);
scout.nodes[0].on.done.escalate.routes = ['command'];
scout.escalation[0].allowedRoutes = ['command'];
const current = await store.publishCatalog(base.PROFILE_ID,{
  catalog:{schema:2,profile:base.PROFILE_ID,routes:{command:published.routeHash},
    bootstrap:{file:'bootstrap/scout.json'}},
  bootstrap:scout,prompts:base.bootstrapPrompts,
}, {expectedCatalogHash:expected || null});
console.log(current.catalogHash);
`
	args := []string{"--input-type=module", "-e", script, f.repo, f.routes, expected, title, mode, transaction}
	return strings.TrimSpace(f.runFixture(t, "node", args...))
}

func (f routeFixture) runFixture(t *testing.T, path string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"), "LC_ALL=C", "HOME=" + f.dir, "GOTOOLCHAIN=local", "GOWORK=off",
		"GOCACHE=" + filepath.Join(f.dir, "tool-cache"),
	}
	if runtime.GOOS == "windows" {
		cmd.Env = append(os.Environ(), cmd.Env...)
	}
	if cache := os.Getenv("GOCACHE"); cache != "" && path == "go" {
		cmd.Env = append(cmd.Env, "GOCACHE="+cache)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("подготовка %s: %v\n%s", path, err, out)
	}
	return string(out)
}

func (f routeFixture) start(t *testing.T, hold bool) (int, string) {
	t.Helper()
	options := []string{"--route", "command", "--ticket-json", filepath.Join(f.dir, "ticket.json"),
		"--expected-catalog-hash", f.catalog}
	if hold {
		options = append(options, "--hold-start")
	}
	return f.run(t, "start", options...)
}

func (f routeFixture) expectStart(t *testing.T, hold bool) {
	t.Helper()
	if rc, out := f.start(t, hold); rc != 0 {
		t.Fatalf("start hold=%v rc=%d: %s", hold, rc, out)
	}
}

func (f routeFixture) run(t *testing.T, mode string, options ...string) (int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	cmd := f.factoryCommand(ctx, mode, options...)
	out, err := cmd.CombinedOutput()
	var status *exec.ExitError
	if errors.As(err, &status) && ctx.Err() == nil {
		return status.ExitCode(), string(out)
	}
	if err != nil {
		t.Fatalf("внешний процесс: %v %s", err, out)
	}
	return 0, string(out)
}

func (f routeFixture) factoryCommand(ctx context.Context, mode string, options ...string) *exec.Cmd {
	argv := []string{testTask, mode, "--profile", "demo-profile",
		"--routes-dir", f.routes, "--state-dir", f.store.StateDir, "--control-dir", f.store.ControlDir}
	cmd := exec.CommandContext(ctx, f.binary, append(argv, options...)...)
	cmd.Env = append(f.launchEnvironment(), f.extraEnv...)
	if runtime.GOOS == "windows" {
		cmd.Env = append(os.Environ(), cmd.Env...)
	}
	if mode == "start" {
		cmd.Env = append(cmd.Env, f.runtimeEnv...)
	}
	return cmd
}

func (f routeFixture) launchEnvironment() []string {
	return []string{
		"PATH=" + os.Getenv("PATH"), "LC_ALL=C", "HOME=" + f.dir, "FACTORY_TESTING=1",
		"FACTORY_FORBID_LIVE=0", "FACTORY_PROFILES_DIR=" + filepath.Dir(f.profile),
		"FACTORY_RUNNERS_DIR=" + filepath.Join(f.dir, "absent-runners"),
		"FIXTURE_ROOT=" + f.dir, "FIXTURE_CHECKOUT=" + f.checkout,
	}
}

func (f routeFixture) assertGate(t *testing.T) {
	t.Helper()
	f.expectCount(t, "command", "1\n")
	f.expectCount(t, "runner", "")
	id := f.attempt(t)
	stage, err := f.store.ReadStage(testTask, id)
	if err != nil || stage.Sequence != 2 || stage.CurrentNode != "gate_accept" || stage.State != "paused" {
		t.Fatalf("нет доверенного head ворот: %+v %v", stage, err)
	}
	if f.projection(t)["GATE_ACCEPT"] != "waiting" {
		t.Fatal("ожидание ворот не отображено")
	}
	var proof struct {
		Attempt       string
		StageIdentity struct {
			Sequence      int
			HeadEventHash string
		}
	}
	raw := f.readServerAttempt(t)
	if err := json.Unmarshal([]byte(raw), &proof); err != nil || proof.Attempt != id ||
		proof.StageIdentity.Sequence != 2 || proof.StageIdentity.HeadEventHash != stage.HeadEventHash {
		t.Fatalf("сервер получил другой курсор ворот: %s (%v)", raw, err)
	}
	t.Logf("attempt=%s eventHead=%s command=1 runner=0", id, stage.HeadEventHash)
}

// readServerAttempt сверяет байты Go с production-читателем текущего сервера.
// Проба передаёт только каталоги изолированного профиля и synthetic task.
func (f routeFixture) readServerAttempt(t *testing.T) string {
	t.Helper()
	program := `
import { pathToFileURL } from 'node:url';
const [root, controlDir, stateDir, profilesDir, routesDir, task] = process.argv.slice(1);
const { FactoryStateAdapter } = await import(pathToFileURL(root + '/server/src/adapters/factoryState.ts'));
const reader = new FactoryStateAdapter({ controlDir, stateDir, profilesDir, routesDir });
console.log(JSON.stringify(await reader.readTrustedAttempt(task)));
`
	return f.runFixture(t, "node", "--input-type=module", "-e", program, f.repo, f.store.ControlDir,
		f.store.StateDir, filepath.Dir(f.profile), f.routes, testTask)
}

func (f routeFixture) attempt(t *testing.T) string {
	t.Helper()
	id := f.projection(t)["ATTEMPT_ID"]
	if !strings.HasPrefix(id, "a_") {
		t.Fatalf("попытка не опубликована: %q", id)
	}
	return id
}

func (f routeFixture) projection(t *testing.T) map[string]string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.store.StateDir, "t"+testTask+".pipeline"))
	if err != nil {
		t.Fatal(err)
	}
	fields := make(map[string]string)
	for _, line := range strings.Split(string(data), "\n") {
		name, value, ok := strings.Cut(line, "=")
		if ok {
			fields[name] = value
		}
	}
	return fields
}

func (f routeFixture) expectCount(t *testing.T, name, expected string) {
	t.Helper()
	f.readEqual(t, filepath.Join(f.dir, name+".count"), expected)
}

func (f routeFixture) readEqual(t *testing.T, name, expected string) {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil || string(data) != expected {
		t.Fatalf("%s: %q %v, ожидалось %q", name, data, err, expected)
	}
}

func (f routeFixture) write(t *testing.T, path, data string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}
