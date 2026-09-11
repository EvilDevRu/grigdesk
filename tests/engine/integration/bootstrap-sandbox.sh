#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
export FACTORY_RUNNERS_DIR="$TEST_ROOT/runners"
export FAKE_ALPHA_RESULT=done
export FACTORY_TERM_GRACE_SECONDS=1
profile_dir="$FACTORY_PROFILES_DIR/demo-profile"
mkdir -p "$profile_dir" "$FACTORY_RUNNERS_DIR" "$TEST_ROOT/source"
git -C "$TEST_ROOT/source" init -q
git -C "$TEST_ROOT/source" config user.name fixture
git -C "$TEST_ROOT/source" config user.email fixture@example.test
printf 'baseline\n' >"$TEST_ROOT/source/tracked.txt"
git -C "$TEST_ROOT/source" add tracked.txt
git -C "$TEST_ROOT/source" commit -qm baseline

cat >"$profile_dir/runners.env" <<'ENV'
RUNNERS_SCHEMA=1
CONFIG_REVISION=1
RUNNERS_COVERAGE=required
PROJECT_RUNNER_PRIMARY=alpha
PROJECT_RUNNER_FAILOVER=
MODEL_DEFAULT_ALPHA_FAMILY=fixture
MODEL_DEFAULT_ALPHA_VERSION=latest
ENV
printf '%s\n' '{"capabilities":["route-v2"]}' >"$profile_dir/graph.json"
cat >"$profile_dir/profile.sh" <<'PROFILE'
PROFILE_NAME=demo-profile
PROFILE_SERVICE_HOST=127.0.0.1
profile_workspace_mode() { printf 'isolated\n'; }
profile_repositories() {
  printf 'app\t%s\t%s\n' "$TEST_ROOT/source" "$FIXTURE_CASE_DIR/worktree"
}
profile_source_branch() { printf 'route-task-%s\n' "$1"; }
profile_container() { printf 'fixture-stand\n'; }
profile_stand_alive() { [[ -f "$FIXTURE_CASE_DIR/up.done" ]]; }
profile_project_context() { printf '%s\n' '{"stack":["fixture"],"guardrails":[]}'; }
PROFILE
cat >"$profile_dir/up.sh" <<'UP'
#!/usr/bin/env bash
set -euo pipefail
task=$1
printf '%s\n' "$$" >"$FIXTURE_CASE_DIR/up.pid"
git -C "$TEST_ROOT/source" worktree add -qb "route-task-$task" "$FIXTURE_CASE_DIR/worktree" HEAD
metadata="$FIXTURE_CASE_DIR/metadata.env"
cat >"$metadata" <<EOF
TASK=$task
WORKSPACE_MODE=isolated
STAND_OWNERSHIP=task
SB_K=1
API_PORT=8801
FE_PORT=8802
SOURCE_BRANCH=route-task-$task
REPO_COUNT=1
REPO_0_NAME=app
REPO_0_SOURCE=$TEST_ROOT/source
REPO_0_WT=$FIXTURE_CASE_DIR/worktree
REPO_0_BRANCH=route-task-$task
EOF
if [[ "$FIXTURE_CASE" != sequential ]]; then
  cp "$metadata" "${FACTORY_BOOTSTRAP_WORKSPACE_ENV}.tmp"
  if [[ "$FIXTURE_CASE" == bad_workspace ]]; then
    sed -i 's|^REPO_0_WT=.*|REPO_0_WT=/missing-workspace|' "${FACTORY_BOOTSTRAP_WORKSPACE_ENV}.tmp"
  fi
  mv "${FACTORY_BOOTSTRAP_WORKSPACE_ENV}.tmp" "$FACTORY_BOOTSTRAP_WORKSPACE_ENV"
  while [[ ! -f "$FIXTURE_CASE_DIR/scout.seen" ]]; do sleep 0.05; done
fi
case "$FIXTURE_CASE" in
  up_failed) exit 42 ;;
  cancel) while true; do sleep 0.05; done ;;
  changed_metadata) sed -i 's/API_PORT=8801/API_PORT=8811/' "$metadata" ;;
esac
cp "$metadata" "$STATE_DIR/t${task}.env"
: >"$FIXTURE_CASE_DIR/up.done"
UP

cat >"$FACTORY_RUNNERS_DIR/alpha.sh" <<'RUNNER'
source "$FACTORY_TESTS_HOME/fakes/runners/alpha.sh"
runner_alpha_run() {
  local task=$1 prompt=$2 stage=$3
  if [[ "$stage" == SCOUT ]]; then
    if [[ "$FIXTURE_CASE" == sequential ]]; then
      [[ -f "$FIXTURE_CASE_DIR/up.done" ]] || return 41
    else
      [[ ! -f "$FIXTURE_CASE_DIR/up.done" ]] || return 41
    fi
    [[ -f "$FIXTURE_CASE_DIR/worktree/tracked.txt" ]] || return 41
    : >"$FIXTURE_CASE_DIR/scout.seen"
    if [[ "$FIXTURE_CASE" == cancel ]]; then
      while true; do sleep 0.05; done
    fi
  elif [[ "$stage" == BUILD ]]; then
    [[ -f "$FIXTURE_CASE_DIR/up.done" ]] || return 41
    : >"$FIXTURE_CASE_DIR/build.seen"
  fi
  FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" \
    --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
    --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" done
}
RUNNER

routes="$TEST_ROOT/routes"
"$NODE_BIN" "$FACTORY_TESTS_HOME/fixtures/routes-catalog-publish.mjs" "$routes" null >/dev/null
assert_rc 0 "$?" "bootstrap fixture publishes its immutable routes"

# Каждый вариант проходит настоящий launcher, typed context, guard и lifecycle.
# Связь scout.seen снимает барьер up.sh: последовательная реализация здесь зависнет.
run_case() {
  local name=$1 task=$2 expected=$3 rc=0
  export FIXTURE_CASE=$name
  export FIXTURE_CASE_DIR="$TEST_ROOT/$name"
  mkdir -p "$FIXTURE_CASE_DIR"
  cat >"$FIXTURE_CASE_DIR/ticket.json" <<EOF
{"schema":1,"taskId":"$task","title":"Параллельная подготовка", "description":"fixture",
"acceptanceCriteria":["BUILD ждёт готовый стенд"],"sourceUrl":"https://example.test/$task"}
EOF
  FACTORY_FORBID_LIVE=0 timeout -k 5 90 "$FACTORY_HOME/bin/factory" "$task" start \
    --profile demo-profile --route trivial --ticket-json "$FIXTURE_CASE_DIR/ticket.json" \
    --delivery-target app=main --routes-dir "$routes" \
    --state-dir "$FIXTURE_CASE_DIR/state" --control-dir "$FIXTURE_CASE_DIR/control" \
    >"$FIXTURE_CASE_DIR/launch.log" 2>&1 || rc=$?
  assert_rc "$expected" "$rc" "$name: launcher preserves the expected outcome"
  if [[ "$rc" != "$expected" ]]; then
    tail -12 "$FIXTURE_CASE_DIR/launch.log"
  fi
}

run_case parallel 6101 0
assert_file_exists "$FIXTURE_CASE_DIR/scout.seen" "scout runs while sandbox preparation is blocked"
assert_file_exists "$FIXTURE_CASE_DIR/build.seen" "build starts after successful sandbox preparation"
assert_contains "$(cat "$FIXTURE_CASE_DIR/state/t6101.pipeline")" 'GATE_ACCEPT=waiting' \
  "parallel preparation still reaches the human acceptance gate"

run_case sequential 6102 0
assert_file_exists "$FIXTURE_CASE_DIR/build.seen" "profile without early metadata keeps working"

run_case up_failed 6103 42
assert_file_exists "$FIXTURE_CASE_DIR/scout.seen" "scout may complete before a provisioning failure"
assert_file_missing "$FIXTURE_CASE_DIR/build.seen" "failed provisioning never launches build"

run_case changed_metadata 6104 75
assert_file_missing "$FIXTURE_CASE_DIR/build.seen" "metadata drift after scout blocks the main route"

run_case bad_workspace 6105 78
assert_file_missing "$FIXTURE_CASE_DIR/scout.seen" "invalid workspace metadata blocks scout"
up_pid=$(cat "$FIXTURE_CASE_DIR/up.pid")
kill -0 "$up_pid" 2>/dev/null
assert_rc 1 "$?" "rejected early metadata stops and reaps sandbox provisioning"

# Ручная остановка во время разведки должна завершить обе принадлежащие запуску
# сессии: модель и ещё не готовый стенд. Отдельный setsid up.sh не делает его сиротой.
export FIXTURE_CASE=cancel
export FIXTURE_CASE_DIR="$TEST_ROOT/cancel"
mkdir -p "$FIXTURE_CASE_DIR"
cat >"$FIXTURE_CASE_DIR/ticket.json" <<'JSON'
{"schema":1,"taskId":"6106","title":"Остановка запуска","description":"fixture",
"acceptanceCriteria":["Нет осиротевшей подготовки"],"sourceUrl":"https://example.test/6106"}
JSON
FACTORY_FORBID_LIVE=0 "$FACTORY_HOME/bin/factory" 6106 start \
  --profile demo-profile --route trivial --ticket-json "$FIXTURE_CASE_DIR/ticket.json" \
  --delivery-target app=main --routes-dir "$routes" \
  --state-dir "$FIXTURE_CASE_DIR/state" --control-dir "$FIXTURE_CASE_DIR/control" \
  >"$FIXTURE_CASE_DIR/launch.log" 2>&1 &
cancel_pid=$!
for poll in {1..300}; do
  [[ ! -f "$FIXTURE_CASE_DIR/scout.seen" ]] || break
  kill -0 "$cancel_pid" 2>/dev/null || break
  sleep 0.1
done
assert_file_exists "$FIXTURE_CASE_DIR/scout.seen" "interrupt fixture reaches concurrent scout and provisioning"
kill -TERM "$cancel_pid" 2>/dev/null || true
cancel_rc=0
wait "$cancel_pid" || cancel_rc=$?
assert_rc 143 "$cancel_rc" "launcher preserves the operator interruption outcome"
assert_file_exists "$FIXTURE_CASE_DIR/up.pid" "interrupted provisioning has a real child process"
up_pid=$(cat "$FIXTURE_CASE_DIR/up.pid")
kill -0 "$up_pid" 2>/dev/null
assert_rc 1 "$?" "operator interruption reaps the sandbox process"
assert_file_missing "$FIXTURE_CASE_DIR/build.seen" "interrupted scout cannot launch build"

finish_tests
