package engine_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

func TestRequiredScout(t *testing.T) {
	f := scoutFixture(t, `result=done`)
	f.expectStart(t, true)
	f.expectCount(t, "runner", "")
	f.expectCount(t, "command", "")
	id := f.attempt(t)
	if rc, out := f.run(t, "resume", "--attempt", id); rc != 0 {
		t.Fatalf("resume с обязательной разведкой rc=%d: %s", rc, out)
	}
	f.checkScoutCheckpoint(t, id)
	// Моделируем разрыв после fsync checkpoint, но до последней записи журнала.
	journal := filepath.Join(f.store.ControlDir, "protocol-v2", "tasks", "t"+testTask,
		"attempts", id, "bootstrap-results")
	entries, err := os.ReadDir(journal)
	if err != nil || len(entries) != 2 {
		t.Fatalf("визит и completed: %v, %v", entries, err)
	}
	completed := filepath.Join(journal, entries[1].Name())
	if err := os.Remove(completed); err != nil {
		t.Fatal(err)
	}
	if rc, out := f.run(t, "resume", "--attempt", id); rc != 0 {
		t.Fatalf("повтор resume rc=%d: %s", rc, out)
	}
	if entries, err = os.ReadDir(journal); err != nil || len(entries) != 2 {
		t.Fatalf("completed не восстановлен: %v, %v", entries, err)
	}
	f.expectCount(t, "runner", "1\n")
	f.expectCount(t, "command", "1\n")
	rc, out := f.run(t, "findings-export", "--attempt", id, "--format", "json")
	if rc != 0 || !strings.Contains(out, "external-check") || !strings.Contains(out, `"phase": "bootstrap"`) {
		t.Fatalf("проекция bootstrap finding rc=%d: %s", rc, out)
	}
	life, err := f.store.ReadLifecycle(testTask, id)
	if err != nil || !slices.ContainsFunc(life, func(event state.LifecycleEvent) bool {
		return event.Data["kind"] == "bootstrap_finished"
	}) {
		t.Fatalf("нет lifecycle завершённого SCOUT: %v", err)
	}
}

func TestScoutGuardBeforeRetry(t *testing.T) {
	f := scoutFixture(t, `printf 'изменение\n' >"$dir/checkout/scope.txt"; exit 0`)
	rc, out := f.start(t, false)
	if rc != 75 || !strings.Contains(out, "workspace guard") {
		t.Fatalf("изменение на молчащем запуске SCOUT rc=%d: %s", rc, out)
	}
	f.expectCount(t, "runner", "1\n")
	f.expectCount(t, "command", "")
	if _, err := f.store.ReadStage(testTask, f.attempt(t)); !errors.Is(err, state.ErrStageAbsent) {
		t.Fatalf("SCOUT открыл основной cursor: %v", err)
	}
}

func TestScoutRunsBeforeStandHealth(t *testing.T) {
	f := scoutFixture(t, `result=done`)
	f.requireEarlyScout(t, "")
	f.expectStart(t, false)
	f.expectCount(t, "runner", "1\n")
	f.expectCount(t, "command", "1\n")
}

func TestScoutQuestionSurvivesStandFailure(t *testing.T) {
	f := scoutFixture(t, `result=failed`)
	f.requireEarlyScout(t, `printf 'DRIFT=1\n' >>"$STATE_DIR/t$1.env"`)
	rc, out := f.start(t, false)
	if rc != 75 || !strings.Contains(out, "ранний и итоговый descriptor различаются") {
		t.Fatalf("граф получил неподтверждённый стенд rc=%d: %s", rc, out)
	}
	id := f.attempt(t)
	f.readScoutStop(t, id)
	f.expectCount(t, "runner", "1\n")
	f.expectCount(t, "command", "")
	if f.projection(t)["BOOTSTRAP_ENV_ERROR"] == "" {
		t.Fatal("ошибка стенда не отражена отдельно от вопроса")
	}
	if _, err := f.store.ReadStage(testTask, id); !errors.Is(err, state.ErrStageAbsent) {
		t.Fatalf("разведка открыла основной cursor: %v", err)
	}
}

// requireEarlyScout даёт up.sh явный барьер завершения после первого вызова SCOUT.
// Фикстура проверяет обратную часть барьера до публикации финального env.
func (f routeFixture) requireEarlyScout(t *testing.T, tail string) {
	t.Helper()
	up := filepath.Join(f.profile, "up.sh")
	script, err := os.ReadFile(up)
	if err != nil {
		t.Fatal(err)
	}
	early := strings.Replace(string(script), `"$STATE_DIR/t$1.env"`, `"$FACTORY_BOOTSTRAP_WORKSPACE_ENV.tmp"`, 1)
	f.write(t, up, early+`
mv -- "$FACTORY_BOOTSTRAP_WORKSPACE_ENV.tmp" "$FACTORY_BOOTSTRAP_WORKSPACE_ENV"
for ((i=0; i<100; i++)); do
  [[ ! -s "$FIXTURE_ROOT/runner.count" ]] || break
  sleep .02
done
[[ -s "$FIXTURE_ROOT/runner.count" ]] || exit 91
[[ ! -s "$FIXTURE_ROOT/command.count" ]] || exit 92
cp -- "$FACTORY_BOOTSTRAP_WORKSPACE_ENV" "$STATE_DIR/t$1.env"
`+tail+"\n")
}

func TestScoutQuestionAndAnswer(t *testing.T) {
	const answer = "Продолжить с согласованным маршрутом"
	f := scoutFixture(t, `result=failed
if grep -q 'Продолжить с согласованным маршрутом' "$dir/scout.prompt"; then
  result=done
fi`)
	f.expectStart(t, false)
	id := f.attempt(t)
	if _, err := f.store.ReadStage(testTask, id); !errors.Is(err, state.ErrStageAbsent) {
		t.Fatalf("вопрос открыл основной cursor: %v", err)
	}
	if f.projection(t)["STALLED_HUMAN"] != "1" {
		t.Fatal("вопрос не остановил попытку")
	}
	if rc, out := f.run(t, "resume", "--attempt", id); rc != 0 {
		t.Fatalf("resume без ответа rc=%d: %s", rc, out)
	}
	f.expectCount(t, "runner", "1\n")
	f.expectCount(t, "command", "")
	visit, stop := f.readScoutStop(t, id)
	reply := filepath.Join(f.dir, "answer.txt")
	f.write(t, reply, answer)
	args := []string{"--attempt", id, "--node", "scout", "--visit", visit, "--stop-hash", stop,
		"--answer-file", reply}
	if rc, out := f.run(t, "bootstrap-answer", args...); rc != 0 {
		t.Fatalf("bootstrap-answer rc=%d: %s", rc, out)
	}
	f.expectCount(t, "runner", "1\n")
	if rc, out := f.run(t, "resume", "--attempt", id); rc != 0 {
		t.Fatalf("resume после ответа rc=%d: %s", rc, out)
	}
	f.checkScoutCheckpoint(t, id)
	f.expectCount(t, "runner", "1\n1\n")
	f.expectCount(t, "command", "1\n")
}

// scoutFixture назначает единственный fake CLI, который пишет настоящий статус.
// Служебные файлы провайдера лежат вне checkout, чтобы не нарушать state-only.
func scoutFixture(t *testing.T, body string) routeFixture {
	t.Helper()
	f := newRouteFixture(t, false)
	f.catalog = f.publishBootstrap(t, f.catalog, "Обязательная разведка", "required")
	profile := filepath.Join(f.profile, "profile.sh")
	raw, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(f.dir, "source")
	f.runFixture(t, "git", "init", "-qb", "shared-main", source)
	f.write(t, profile, string(raw)+`
profile_workspace_mode() { printf 'isolated\n'; }
profile_repositories() { printf 'app\t%s\t%s\n' "$FIXTURE_SOURCE" "$FIXTURE_CHECKOUT"; }
`)
	f.write(t, filepath.Join(f.profile, "up.sh"), `#!/usr/bin/env bash
cat >"$STATE_DIR/t$1.env" <<EOF
TASK=$1
WORKSPACE_MODE=isolated
STAND_OWNERSHIP=task
SB_K=0
API_PORT=8830
FE_PORT=8830
SOURCE_BRANCH=shared-main
REPO_COUNT=1
REPO_0_NAME=app
REPO_0_SOURCE=$FIXTURE_SOURCE
REPO_0_WT=$FIXTURE_CHECKOUT
REPO_0_BRANCH=shared-main
EOF
`)
	f.write(t, filepath.Join(f.profile, "runners.env"), "RUNNERS_SCHEMA=1\nCONFIG_REVISION=1\n"+
		"RUNNERS_COVERAGE=required\nPROJECT_RUNNER_PRIMARY=codex\nPROJECT_RUNNER_FAILOVER=\n")
	path := filepath.Join(f.dir, "codex")
	f.write(t, path, `#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == --version ]]; then
  printf '%s\n' 'codex-cli 0.106.0'
  exit 0
fi
dir=$(dirname -- "$0")
cat >"$dir/scout.prompt"
[[ "$FACTORY_RUN_STAGE" == SCOUT ]]
printf '1\n' >>"$dir/runner.count"
`+body+`
extra=()
if [[ "$result" == done ]]; then
  extra=(--finding-deferred 'external-check=Проверить в отдельной среде')
fi
"$FACTORY_STATUS_BIN" stage-result --task "$FACTORY_RUN_TASK" \
  --stage "$FACTORY_RUN_STAGE" --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" "${extra[@]}" "$result"
`)
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	f.extraEnv = []string{"GRIGDESK_CODEX_BIN=" + path, "FIXTURE_SOURCE=" + source}
	return f
}

// checkScoutCheckpoint сверяет точную identity сохранённого checkpoint и результат.
// В примере прогона SCOUT создаёт checkpoint до открытия основного cursor.
func (f routeFixture) checkScoutCheckpoint(t *testing.T, id string) {
	t.Helper()
	a, err := f.store.ReadAttempt(testTask, id)
	if err != nil {
		t.Fatal(err)
	}
	raw, _, err := f.store.AttemptArtifact(a, "bootstrap.json", nil, false)
	var checkpoint struct {
		TaskID, AttemptID, Profile, CatalogHash, RouteID, RouteHash, RunKey, Result string
	}
	if err != nil || json.Unmarshal(raw, &checkpoint) != nil ||
		checkpoint.TaskID != a.Task || checkpoint.AttemptID != a.ID ||
		checkpoint.Profile != a.Profile || checkpoint.CatalogHash != a.CatalogHash ||
		checkpoint.RouteID != a.RouteID || checkpoint.RouteHash != a.RouteHash ||
		checkpoint.RunKey != "SCOUT" || checkpoint.Result != "done" {
		t.Fatalf("checkpoint: %s %v", raw, err)
	}
}

// readScoutStop сверяет вопрос production-читателем, которым пользуется карточка.
// Возвращённые visit и hash используются публичным CAS ответа.
func (f routeFixture) readScoutStop(t *testing.T, id string) (string, string) {
	t.Helper()
	raw := f.readServerAttempt(t)
	var journal struct {
		Attempt       string
		BootstrapStop struct {
			State, VisitID, RecordHash string
		}
	}
	if err := json.Unmarshal([]byte(raw), &journal); err != nil || journal.Attempt != id ||
		journal.BootstrapStop.State != "waiting" || journal.BootstrapStop.VisitID == "" ||
		journal.BootstrapStop.RecordHash == "" {
		t.Fatalf("журнал вопроса: %s %v", raw, err)
	}
	return journal.BootstrapStop.VisitID, journal.BootstrapStop.RecordHash
}
