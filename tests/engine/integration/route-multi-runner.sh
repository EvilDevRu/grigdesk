#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture" "$TEST_ROOT/work"
config="$FACTORY_PROFILES_DIR/fixture/runners.env"
printf '%s\n' \
  'RUNNERS_SCHEMA=1' \
  'CONFIG_REVISION=1' \
  'PROJECT_RUNNER_PRIMARY=alpha' \
  'PROJECT_RUNNER_FAILOVER=beta' \
  'MODEL_BUILD_ALPHA_FAMILY=fixture' \
  'MODEL_BUILD_ALPHA_VERSION=latest' \
  'MODEL_BUILD_ALPHA_EFFORT=high' \
  'MODEL_BUILD_BETA_FAMILY=fixture' \
  'MODEL_BUILD_BETA_VERSION=latest' \
  'MODEL_BUILD_BETA_EFFORT=high' >"$config"

PROFILE_NAME=fixture
PROFILE_AGENT_CWD="$TEST_ROOT/work"
PROFILE_AGENT_DIRS="$TEST_ROOT/work"
source "$FACTORY_HOME/lib/core.sh"

init_registry() {
  pipeline_store_route_init "$1" BUILD PROFILE fixture
}

# Route runtime вызывает ровно этот provider-neutral primitive. Доказанный limit
# меняет provider внутри одного захода узла, не возвращаясь к удалённому run_stage.
init_registry 41
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=limited
export FAKE_BETA_CAPTURE_ACTIVE_REASON=1
run_agent 41 'route fixture work' BUILD
assert_rc 0 "$?" "route agent completes through the configured failover"
assert_eq done "$(get 41 BUILD)" "run-scoped result reaches the route registry"
assert_eq $'alpha\nbeta' "$(cat "$TEST_ROOT/invocations")" \
  "proven limit changes provider exactly once"
assert_eq beta "$(get 41 RUNNER_ACTUAL_BUILD)" \
  "actual provider is visible in the registry"
assert_eq alpha "$(get 41 RUNNER_REQUESTED_BUILD)" \
  "requested primary is preserved across failover"
assert_eq fallback_limit "$(get 41 RUNNER_REASON_BUILD)" \
  "failover reason is visible after the route run"
assert_eq fallback_limit "$(cat "$TEST_ROOT/beta.active-reason")" \
  "failover reason is visible while the reserve is running"
assert_eq native "$(get 41 PLAN_LEVEL_BUILD)" \
  "runner capability planning no longer depends on a profile fanout hook"
assert_file_missing "$(runner_trusted_identity_file 41)" \
  "completed route run leaves no stale trusted process identity"
unset FAKE_BETA_CAPTURE_ACTIVE_REASON

alpha_fingerprint=$(printf 'alpha|default' | sha256sum | awk '{print substr($1,1,24)}')
breaker_clear alpha "$alpha_fingerprint" provider "" ""
init_registry 42
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=unknown
run_agent 42 'route fixture work' BUILD >/dev/null 2>&1
assert_rc 1 "$?" "unknown provider failure returns to route retry policy"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" \
  "unknown failure never changes provider"

breaker_clear alpha "$alpha_fingerprint" provider "" ""
init_registry 43
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=failed
run_agent 43 'route fixture work' BUILD >/dev/null 2>&1
assert_rc 0 "$?" "semantic runner result is transported without host failure"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" \
  "semantic failure never invokes provider fallback"
assert_eq failed "$(get 43 BUILD)" \
  "route runtime can read the committed semantic failure"

# Immutable node.fanout доезжает до provider capability plan. Native runner
# получает явное указание на read-only веер; runner без capability допускается
# только при объявленном allow-single и видит явную последовательную деградацию.
init_registry 45
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=done
FACTORY_ROUTE_FANOUT_MODE=parallel \
FACTORY_ROUTE_FANOUT_MAX=3 \
FACTORY_ROUTE_FANOUT_DEGRADE=forbid \
  run_agent 45 'раздели независимые зоны' BUILD
assert_rc 0 "$?" "native fanout capability satisfies strict route policy"
assert_eq native "$(get 45 PLAN_LEVEL_BUILD)" \
  "native fanout is recorded in the execution plan"

pipeline_store_route_init 451 BUILD PROFILE fixture \
  RUNNER_OVERRIDE_PRIMARY beta RUNNER_OVERRIDE_FAILOVER ''
: >"$TEST_ROOT/invocations"
FACTORY_ROUTE_FANOUT_MODE=parallel \
FACTORY_ROUTE_FANOUT_MAX=3 \
FACTORY_ROUTE_FANOUT_DEGRADE=allow-single \
  run_agent 451 'раздели независимые зоны' BUILD
assert_rc 0 "$?" "allow-single runs on a provider without native fanout"
assert_eq degraded "$(get 451 PLAN_LEVEL_BUILD)" \
  "fanout degradation is explicit in the execution plan"
assert_contains "$(cat "$TEST_ROOT/beta.prompt")" 'РЕЖИМ СОВМЕСТИМОСТИ' \
  "degraded runner is told to preserve independent roles sequentially"

# Operator switch remains run-scoped: provider-writable metadata cannot redirect
# the signal or replacement target.
breaker_clear alpha "$alpha_fingerprint" provider "" ""
init_registry 44
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=wait
run_agent 44 'route fixture work' BUILD >"$TEST_ROOT/switch-stage.out" 2>&1 &
stage_pid=$!
meta=""
trusted_identity=$(runner_trusted_identity_file 44)
for _poll in {1..200}; do
  meta=$(find "$STATE_DIR/logs/runs/t44/BUILD" -name meta.env -type f 2>/dev/null | head -1)
  if [[ -n "$meta" && -f "$trusted_identity" &&
        "$(cat "$TEST_ROOT/invocations")" == alpha ]]; then
    break
  fi
  kill -0 "$stage_pid" 2>/dev/null || break
  sleep 0.02
done
assert_file_exists "$meta" "active route run publishes diagnostic metadata"
assert_file_exists "$trusted_identity" \
  "active route run publishes a trusted process identity"
read -r _ _ _ _ old_pid _ _ _ < <(runner_trusted_identity_read 44)
sed -i \
  -e 's/^PID=.*/PID=1/' \
  -e 's/^PGID=.*/PGID=1/' \
  -e 's/^STARTTIME=.*/STARTTIME=1/' \
  "$meta"
"$FACTORY_HOME/bin/factory" 44 runner switch BUILD beta >"$TEST_ROOT/switch.out"
assert_rc 0 "$?" "CLI switches the exact active route run"
wait "$stage_pid"
assert_rc 0 "$?" "replacement provider commits the route result"
assert_eq $'alpha\nbeta' "$(cat "$TEST_ROOT/invocations")" \
  "manual switch replaces only the active provider"
assert_eq done "$(get 44 BUILD)" "replacement result reaches the route registry"
assert_eq manual_switch "$(get 44 RUNNER_REASON_BUILD)" \
  "manual switch remains visible to the route runtime"
assert_eq manual_switch "$(awk -F= '$1=="RESULT_CLASS"{v=$2} END{print v}' "$meta")" \
  "provider-writable metadata cannot redirect the trusted switch"
kill -0 "$old_pid" 2>/dev/null
assert_rc 1 "$?" "replaced provider process is reaped"
assert_file_missing "$trusted_identity" \
  "replacement completion clears trusted process identity"

init_registry 46
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=denied
run_agent 46 'route fixture work' BUILD >/dev/null 2>&1
assert_rc 79 "$?" "sandbox denial is a host/config refusal for route runtime"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" \
  "sandbox denial is not retried on another provider"
assert_eq 1 "$(get 46 STALLED_HUMAN)" \
  "sandbox denial requests human action"

# Эти сценарии проверяют семантику движка через stage-result, а не native права.
# Отказ одной команды не мешает разрешённой альтернативе; код 0 без статуса не done.
for fixture_result in review-alternative human no-status; do
  case "$fixture_result" in
    review-alternative) review_task=461 ;;
    human) review_task=462 ;;
    no-status) review_task=463 ;;
  esac
  init_registry "$review_task"
  : >"$TEST_ROOT/invocations"
  export FAKE_ALPHA_RESULT="$fixture_result"
  run_agent "$review_task" 'route review fixture' BUILD >/dev/null 2>&1
  review_rc=$?
  assert_eq alpha "$(cat "$TEST_ROOT/invocations")" "$fixture_result не переключает provider"

  if [[ "$fixture_result" == no-status ]]; then
    assert_rc 0 "$review_rc" "transport возвращает код завершившегося провайдера"
    assert_eq running "$(get "$review_task" BUILD)" "rc=0 без stage-result не становится done"
    source "$FACTORY_HOME/lib/route-runtime.sh"
    _route_v2_active_result "$(run_state_active_file "$review_task" BUILD)" >/dev/null 2>&1
    assert_rc 78 "$?" "route reader отвергает отсутствие terminal status"
  else
    assert_rc 0 "$review_rc" "$fixture_result доставляет семантический результат"
    if [[ "$fixture_result" == human ]]; then
      assert_eq failed "$(get "$review_task" BUILD)" "отказ сдачи остаётся failed"
    else
      assert_eq done "$(get "$review_task" BUILD)" "разрешённая альтернатива завершает этап"
      assert_file_exists "$TEST_ROOT/alternative-effect" "done подтверждён эффектом альтернативы"
    fi
  fi
done

breaker_clear alpha "$alpha_fingerprint" provider "" ""
init_registry 47
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=timeout
run_agent 47 'route fixture work' BUILD >/dev/null 2>&1
assert_rc 124 "$?" "provider timeout returns to the route retry budget"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" \
  "timeout never changes provider"

# Инфраструктурный отказ launch barrier не является ошибкой модели и не выбирает резерв.
# Настоящие publisher/relay покрыты контрактным тестом; здесь проверяем путь диспетчера.
saved_browser_start=$(declare -f browser_transport_start)
browser_transport_start() {
  BROWSER_TRANSPORT_ERROR=browser_run_stale
  return 79
}
init_registry 470
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=done
run_agent 470 'browser launch failure' BUILD >/dev/null 2>&1
assert_rc 79 "$?" 'browser launch failure reaches route runtime as host refusal'
assert_eq '' "$(cat "$TEST_ROOT/invocations")" 'browser failure invokes neither primary nor reserve'
assert_eq browser_run_stale "$BROWSER_TRANSPORT_ERROR" 'dispatcher retains exact transport cause'
assert_eq 0 "$DISPATCH_INVOKE_STARTED" 'transport failure precedes model activity'
assert_eq 1 "$(get 470 STALLED_HUMAN)" 'browser failure leaves resumable host stop'
eval "$saved_browser_start"

printf 'RUNNERS_COVERAGE=required\n' >>"$config"
init_registry 48
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=done
run_agent 48 'route fixture work' BUILD >/dev/null 2>&1
assert_rc 79 "$?" "missing current coverage fails closed before route execution"
assert_eq "" "$(cat "$TEST_ROOT/invocations")" \
  "coverage gate blocks every provider call"
assert_eq coverage_unavailable "$(get 48 RUNNER_REASON_BUILD)" \
  "coverage refusal stays visible in the route registry"

# --- Task-level --runner-primary из start: первый агент-этап идёт на выбранном
# исполнителе, а источником цепочки становится реестр задачи, а не runners.env.
# Каталог маршрутов fixture публикуется для demo-profile, поэтому полный start
# идёт отдельным профилем с той же runner-политикой.
printf '%s\n' \
  'MODEL_DEFAULT_ALPHA_FAMILY=fixture' \
  'MODEL_DEFAULT_ALPHA_VERSION=latest' \
  'MODEL_DEFAULT_BETA_FAMILY=fixture' \
  'MODEL_DEFAULT_BETA_VERSION=latest' >>"$config"
start_profile_dir="$FACTORY_PROFILES_DIR/demo-profile"
mkdir -p "$start_profile_dir"
cp -- "$config" "$start_profile_dir/runners.env"
printf '%s\n' '{"capabilities":["route-v2"]}' >"$start_profile_dir/graph.json"

start_repo="$TEST_ROOT/start-checkout"
mkdir -p "$start_repo"
git -C "$start_repo" init -q
git -C "$start_repo" config user.name fixture
git -C "$start_repo" config user.email fixture@example.test
git -C "$start_repo" checkout -qb shared-main
printf 'baseline\n' >"$start_repo/tracked.txt"
git -C "$start_repo" add tracked.txt
git -C "$start_repo" commit -qm baseline

cat >"$start_profile_dir/profile.sh" <<PROFILE
PROFILE_NAME=demo-profile
PROFILE_SERVICE_HOST=127.0.0.1
profile_workspace_mode() { printf 'shared\n'; }
profile_repositories() { printf 'app\\t%s\\t%s\\n' '$start_repo' '$start_repo'; }
profile_source_branch() { printf 'shared-main\\n'; }
profile_container() { printf 'fixture-stand\\n'; }
profile_stand_alive() { return 0; }
profile_project_context() { printf '%s\\n' '{"stack":["fixture"],"guardrails":[]}'; }
profile_service_ports() { printf '8830\\t8830\\n'; }
profile_exclusive_resources() {
  printf '%s\\n' 'stand:fixture-stand' 'workspace:$start_repo'
}
PROFILE

routes_dir="$TEST_ROOT/routes"
"$NODE_BIN" "$FACTORY_TESTS_HOME/fixtures/routes-catalog-publish.mjs" \
  "$routes_dir" null >/dev/null
assert_rc 0 "$?" "route catalog publishes for start override"

ticket="$TEST_ROOT/ticket-start.json"
cat >"$ticket" <<'JSON'
{
  "schema": 1,
  "taskId": "49",
  "title": "runner override",
  "description": "task-level primary override",
  "acceptanceCriteria": ["first agent stage runs on the chosen runner"],
  "sourceUrl": "https://portal.example.test/fixtures/49"
}
JSON

start_state="$TEST_ROOT/start-state"
start_control="$TEST_ROOT/start-control"
start_out=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  "$FACTORY_HOME/bin/factory" 49 start --profile demo-profile \
  --route feature \
  --ticket-json "$ticket" \
  --delivery-target app=main \
  --runner-primary beta \
  --routes-dir "$routes_dir" \
  --state-dir "$start_state" \
  --control-dir "$start_control" 2>&1)
start_rc=$?
if (( start_rc != 0 )); then test_note "start --runner-primary beta: $start_out"; fi
assert_rc 0 "$start_rc" "start with --runner-primary beta reaches the human gate"
start_registry="$start_state/t49.pipeline"
assert_eq beta "$(awk -F= '$1=="RUNNER_OVERRIDE_PRIMARY"{print $2}' "$start_registry")" \
  "start records the task-level primary in the registry"
assert_eq beta "$(awk -F= '$1=="RUNNER_ACTUAL_SCOUT"{print $2}' "$start_registry")" \
  "first agent stage runs on the chosen runner"
assert_eq beta "$(awk -F= '$1=="RUNNER_REQUESTED_SCOUT"{print $2}' "$start_registry")" \
  "requested primary matches the override from the first stage on"
route=$(routing_resolve "$start_profile_dir/runners.env" "$start_registry" SCOUT)
assert_contains "$route" "PRIMARY=beta" \
  "routing takes the chain from the task registry"
assert_contains "$route" "SOURCE=task" \
  "routing marks the task registry as the chain source"

finish_tests
