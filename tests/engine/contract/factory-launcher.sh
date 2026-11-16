#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

tool="$FACTORY_HOME/bin/factory"
routes="$TEST_ROOT/routes"
publisher="$FACTORY_TESTS_HOME/fixtures/routes-catalog-publish.mjs"
profile_id=demo-profile
fixture_task=9001
fixture_attempt=a_90019001900190019001900190019001

export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
profile_dir="$FACTORY_PROFILES_DIR/$profile_id"
mkdir -p "$profile_dir"
printf 'PROFILE_NAME=%s\n' "$profile_id" >"$profile_dir/profile.sh"
printf '%s\n' \
  RUNNERS_SCHEMA=1 \
  CONFIG_REVISION=1 \
  RUNNERS_COVERAGE=required \
  PROJECT_RUNNER_PRIMARY=alpha \
  PROJECT_RUNNER_FAILOVER= \
  STAGE_REVIEW_PRIMARY=beta \
  MODEL_DEFAULT_ALPHA_FAMILY=fixture \
  MODEL_DEFAULT_ALPHA_VERSION=latest \
  MODEL_DEFAULT_BETA_FAMILY=fixture \
  MODEL_DEFAULT_BETA_VERSION=latest \
  >"$profile_dir/runners.env"
printf '%s\n' '{"capabilities":["route-v2"]}' >"$profile_dir/graph.json"

slots=$("$tool" slots --profile "$profile_id")
assert_rc 0 "$?" "profile without slot allocator reports an optional capability"
assert_eq false "$(jq -r '.supported' <<<"$slots")" \
  "shared profile without profile_slots is not rejected"
assert_eq '[]' "$(jq -c '.used' <<<"$slots")" \
  "unsupported slots return an empty used set"
assert_eq '[]' "$(jq -c '.free' <<<"$slots")" \
  "unsupported slots return an empty free set"

published_initial=$("$NODE_BIN" "$publisher" "$routes" null)
assert_rc 0 "$?" "route source publishes for launcher contract"
catalog_initial=$(jq -r '.catalogHash' <<<"$published_initial")

for route in debug consilium-debug feature trivial hunt; do
  output=$("$tool" check --profile "$profile_id" --route "$route" --routes-dir "$routes")
  assert_rc 0 "$?" "launcher validates route=$route without a task launch"
  assert_contains "$output" "route=$route" \
    "check reports the validated route"
  if [[ "$route" == hunt ]]; then
    assert_contains "$output" 'delivery=disabled' \
      "no-ship route advertises disabled delivery"
  else
    assert_contains "$output" 'delivery=publish' \
      "ship route advertises publish delivery"
  fi
  case "$route" in
    debug|consilium-debug)
      assert_contains "$output" 'instrumentation=explicit' \
        "transactional instrument advertises explicit scope independently of route id"
      ;;
    *)
      assert_contains "$output" 'instrumentation=disabled' \
        "route without transactional nodes advertises disabled instrumentation"
      ;;
  esac
done

expected_check=$("$tool" check --profile "$profile_id" --route feature \
  --expected-catalog-hash "$catalog_initial" --routes-dir "$routes")
assert_rc 0 "$?" "check accepts a matching expected catalog as a fast-fail guard"
assert_contains "$expected_check" "catalog=$catalog_initial" \
  "check reports the exact expected catalog it verified"
stale_catalog=$(printf '0%.0s' {1..64})
stale_check=$("$tool" check --profile "$profile_id" --route feature \
  --expected-catalog-hash "$stale_catalog" --routes-dir "$routes" 2>&1)
assert_rc 75 "$?" "check rejects a stale expected catalog without lifecycle mutation"
assert_contains "$stale_check" \
  "FACTORY_ERROR=catalog_changed EXPECTED=$stale_catalog ACTUAL=$catalog_initial" \
  "check mismatch exposes the stable catalog_changed marker"

dispatch_id=00000000-0000-4000-8000-000000000002
dispatch_on_check=$("$tool" check --profile "$profile_id" --route feature \
  --queue-dispatch-id "$dispatch_id" --routes-dir "$routes" 2>&1)
assert_rc 78 "$?" "queue dispatch id is not accepted by side-effect-free check"
assert_contains "$dispatch_on_check" '--queue-dispatch-id допустим только при start' \
  "check rejection names the start-only dispatch boundary"
dispatch_without_expected=$("$tool" "$fixture_task" start --profile "$profile_id" \
  --route feature --queue-dispatch-id "$dispatch_id" --routes-dir "$routes" 2>&1)
assert_rc 78 "$?" "start rejects queue dispatch without an expected catalog"
assert_contains "$dispatch_without_expected" \
  '--queue-dispatch-id требует --expected-catalog-hash' \
  "dispatch rejection names the catalog guard dependency"
invalid_dispatch=$("$tool" "$fixture_task" start --profile "$profile_id" \
  --route feature --expected-catalog-hash "$catalog_initial" \
  --queue-dispatch-id not-a-uuid \
  --routes-dir "$routes" 2>&1)
assert_rc 78 "$?" "start rejects a non-RFC dispatch UUID before lifecycle mutation"
assert_contains "$invalid_dispatch" 'queue-dispatch-id: нужен UUID' \
  "invalid UUID rejection is explicit"

uppercase_dispatch=00000000-0000-4000-8000-00000000000A
uppercase_state="$TEST_ROOT/uppercase-dispatch-state"
uppercase_control="$TEST_ROOT/uppercase-dispatch-control"
uppercase_dispatch_error=$("$tool" "$fixture_task" start --profile "$profile_id" \
  --route feature --expected-catalog-hash "$catalog_initial" \
  --queue-dispatch-id "$uppercase_dispatch" \
  --routes-dir "$routes" \
  --state-dir "$uppercase_state" \
  --control-dir "$uppercase_control" 2>&1)
assert_rc 78 "$?" "start rejects uppercase dispatch UUID before lifecycle mutation"
assert_contains "$uppercase_dispatch_error" \
  'queue-dispatch-id: нужен UUID в нижнем регистре' \
  "uppercase UUID rejection names the lowercase contract"
assert_file_missing "$uppercase_state" \
  "uppercase dispatch UUID creates no route state"
assert_file_missing "$uppercase_control" \
  "uppercase dispatch UUID creates no trusted control state"

source_text=$(cat "$tool")
case "$source_text" in
  *factory-canary*|*canary-no-publish*|*FACTORY_CANARY*)
    test_fail "launcher contains no separate rollout runtime"
    ;;
  *)
    test_ok "launcher contains no separate rollout runtime"
    ;;
esac
assert_contains "$source_text" '--runner-primary)' \
  "launcher accepts an explicit task-level runner override"
assert_contains "$source_text" \
  'RUNNER_OVERRIDE_PRIMARY "$V2_ATTEMPT_RUNNER_PRIMARY_OVERRIDE"' \
  "task-level override reaches the registry only from trusted attempt identity"
assert_contains "$source_text" "profile_runner_host_preflight" \
  "launcher verifies the configured provider chain"
assert_contains "$source_text" "for action in commit push pull-request" \
  "typed context grants SHIP commit, push and pull-request creation"
assert_contains "$source_text" 'if [[ "$V2_HAS_SHIP" == 1 ]]' \
  "delivery actions and targets are conditional on pinned ship topology"
assert_contains "$source_text" 'DELIVERY_MODE "$V2_DELIVERY_MODE"' \
  "registry records publish or disabled delivery mode"
assert_contains "$source_text" "FACTORY_WORKSPACE_MODE=isolated" \
  "isolated start declares its workspace mode to profile provisioning"
assert_contains "$source_text" "FACTORY_REQUIRE_NEW_SANDBOX=1" \
  "isolated start requires a fresh task-owned sandbox"
case "$source_text" in
  *FACTORY_SANDBOX_GENERATION*)
    test_fail "launcher exports no generation-specific sandbox selector"
    ;;
  *)
    test_ok "launcher exports no generation-specific sandbox selector"
    ;;
esac
assert_contains "$source_text" "gate_plan) printf 'GATE_PLAN" \
  "plan gate has a compatibility projection for GrigDesk"
assert_contains "$source_text" "gate_cause) printf 'GATE_CAUSE" \
  "cause gate has a compatibility projection for GrigDesk"
assert_contains "$source_text" "gate_accept) printf 'GATE_ACCEPT" \
  "acceptance gate has a compatibility projection for GrigDesk"
assert_contains "$source_text" '"$pipeline_gate_key" "$GATE_DECISION"' \
  "accepted or rejected gate decisions are projected to GrigDesk"
assert_contains "$source_text" '"$pipeline_gate_key" waiting STALLED_HUMAN 1' \
  "a paused trusted cursor is projected as a waiting GrigDesk gate"
# Синхронному вызывающему (GrigDesk по HTTP) нужен выход сразу после фиксации:
# иначе gate ведёт маршрут дальше и переживает чужой таймаут только сиротой.
# Снятие STALLED_HUMAN — строго ПОСЛЕ CAS: упавший commit-only не имеет права
# стирать маркер остановки у стоящего маршрута.
assert_contains "$source_text" 'v2_gate_commit "$attempt" || return
    set_st "$TASK" STALLED_HUMAN 0 || return
    return 0' \
  "--commit-only records the decision and leaves the route to a separate resume"
assert_contains "$source_text" 'GATE_COMMIT_ONLY" == 1 ]] ||' \
  "commit-only is rejected outside the gate mode"
# Реестр читает не только GrigDesk, но и агенты: иначе PLAN может увидеть в нём
# TESTS=done от отменённой попытки и пойти искать несуществующие тесты.
assert_contains "$source_text" 'set_st "$TASK" --init --stages "$(v2_registry_stage_keys "$new_catalog")"' \
  "recovery re-inits the registry from the newly pinned catalog"
assert_contains "$source_text" 'v2_quarantine_state_artifacts "$EXPECTED_ATTEMPT" || return' \
  "recovery takes the predecessor stage artifacts off the disk"
# Штатная остановка по сигналу помечается в реестре, чтобы GrigDesk отличал решение
# человека от обрыва: демона нет, STALLED_HUMAN нет, а звонить «Конвейер оборвался»
# на собственную кнопку остановки нельзя. Метку снимает любой новый заход движка.
assert_contains "$source_text" 'set_st "$TASK" STOPPED_SIGNAL 1' \
  "a proven graceful signal stop marks the registry so GrigDesk tells it from a crash"
assert_contains "$source_text" 'ORCH_PID "$$" STALLED_HUMAN 0 STOPPED_SIGNAL 0' \
  "a new engine run clears the graceful-stop marker atomically with daemon registration"
assert_contains "$source_text" 'STALLED_HUMAN 0 STOPPED_SIGNAL 0 RESULT recovered' \
  "recovery clears the graceful-stop marker of the predecessor"

ticket="$TEST_ROOT/ticket.json"
cat >"$ticket" <<JSON
{
  "schema": 1,
  "taskId": "$fixture_task",
  "title": "offline boundary",
  "description": "must not launch",
  "acceptanceCriteria": ["no live mutation"],
  "sourceUrl": "https://portal.example.test/fixtures/$fixture_task"
}
JSON

no_ship_error=$("$tool" "$fixture_task" start --profile "$profile_id" \
  --route hunt \
  --ticket-json "$ticket" \
  --delivery-target be=master \
  --routes-dir "$routes" \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" 2>&1)
assert_rc 78 "$?" "no-ship route rejects explicit delivery before lifecycle mutation"
assert_contains "$no_ship_error" 'не имеет ship' \
  "launcher explains why delivery arguments are invalid"
assert_file_missing "$TEST_ROOT/live-state" \
  "invalid no-ship delivery leaves no partial state"

renamed_scope_error=$(FACTORY_FORBID_LIVE=0 \
  "$tool" "$fixture_task" start --profile "$profile_id" \
  --route consilium-debug \
  --ticket-json "$ticket" \
  --routes-dir "$routes" \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" 2>&1)
assert_rc 78 "$?" "renamed diagnostic route requires explicit scope before lifecycle mutation"
assert_contains "$renamed_scope_error" 'route=consilium-debug требует --instrumentation-file' \
  "scope rejection names the semantic route instead of hard-coding debug"
assert_file_missing "$TEST_ROOT/live-state" \
  "missing explicit scope leaves no partial state"

feature_scope_error=$(FACTORY_FORBID_LIVE=0 \
  "$tool" "$fixture_task" start --profile "$profile_id" \
  --route feature \
  --ticket-json "$ticket" \
  --instrumentation-file app:tracked.txt \
  --routes-dir "$routes" \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" 2>&1)
assert_rc 78 "$?" "route without explicit instrumentation rejects browser scope"
assert_contains "$feature_scope_error" 'route=feature не принимает явный --instrumentation-file' \
  "disabled scope rejection is topology-based"
assert_file_missing "$TEST_ROOT/live-state" \
  "inapplicable explicit scope leaves no partial state"

"$tool" "$fixture_task" start --profile "$profile_id" \
  --route feature \
  --ticket-json "$ticket" \
  --routes-dir "$routes" \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" >/dev/null 2>&1
assert_rc 78 "$?" "offline harness blocks start before provisioning or model calls"
assert_file_missing "$TEST_ROOT/live-state" \
  "blocked live lifecycle does not create route state"

"$tool" "$fixture_task" abandon --profile "$profile_id" \
  --attempt "$fixture_attempt" \
  --reason 'offline harness' \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" >/dev/null 2>&1
assert_rc 78 "$?" "offline harness blocks abandon as a live mutation"

"$tool" "$fixture_task" recover --profile "$profile_id" \
  --attempt "$fixture_attempt" \
  --reason 'offline harness' \
  --route feature \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" >/dev/null 2>&1
assert_rc 78 "$?" "offline harness blocks recover as a live mutation"
assert_file_missing "$TEST_ROOT/live-state" \
  "blocked admin lifecycle does not create route state"

# Shared checkout — не ослабленный isolated mode, а отдельный профильный контракт.
# Fixture снимает live-запрет только для полностью локальных fake runners/hooks:
# никаких контейнеров, worktree или внешних процессов он не создаёт.
shared_repo="$TEST_ROOT/work/shared-checkout"
mkdir -p "$shared_repo"
git -C "$shared_repo" init -q
git -C "$shared_repo" config user.name fixture
git -C "$shared_repo" config user.email fixture@example.test
git -C "$shared_repo" checkout -qb shared-main
printf 'baseline\n' >"$shared_repo/tracked.txt"
git -C "$shared_repo" add tracked.txt
git -C "$shared_repo" commit -qm baseline

cat >"$profile_dir/profile.sh" <<PROFILE
PROFILE_NAME=$profile_id
PROFILE_SERVICE_HOST=127.0.0.1
profile_workspace_mode() { printf '%s\n' "\${FIXTURE_WORKSPACE_MODE:-shared}"; }
profile_repositories() { printf 'app\\t%s\\t%s\\n' '$shared_repo' '$shared_repo'; }
profile_source_branch() { printf 'shared-main\\n'; }
profile_container() { printf 'fixture-stand\\n'; }
profile_stand_alive() {
  if [[ -n "\${FIXTURE_STAND_BARRIER:-}" ]]; then
    : >"\${FIXTURE_STAND_BARRIER}.ready"
    while [[ ! -e "\${FIXTURE_STAND_BARRIER}.release" ]]; do sleep 0.02; done
  fi
  return 0
}
profile_project_context() { printf '%s\\n' '{"stack":["fixture"],"guardrails":[]}'; }
profile_service_ports() { printf '8830\\t8830\\n'; }
profile_exclusive_resources() {
  printf '%s\\n' 'gpu:fixture' 'stand:fixture-stand' 'workspace:$shared_repo'
}
PROFILE
cat >"$profile_dir/up.sh" <<'SH'
#!/usr/bin/env bash
touch "${TEST_ROOT:?}/shared-up-called"
exit 99
SH
cat >"$profile_dir/down.sh" <<'SH'
#!/usr/bin/env bash
touch "${TEST_ROOT:?}/shared-down-called"
exit 99
SH
chmod +x "$profile_dir/up.sh" "$profile_dir/down.sh"

shared_state="$TEST_ROOT/shared-state"
shared_control="$TEST_ROOT/shared-control"
isolated_error=$(FACTORY_FORBID_LIVE=0 FIXTURE_WORKSPACE_MODE=isolated \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" start --profile "$profile_id" \
    --route feature \
    --ticket-json "$ticket" \
    --delivery-target app=main \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 78 "$?" "isolated mode rejects source equal to workspace"
assert_contains "$isolated_error" 'isolated workspace app не должен пересекаться' \
  "isolated rejection names the violated disjointness contract"
assert_file_missing "$shared_state/t${fixture_task}.pipeline" \
  "rejected isolated topology creates no task registry"

# Единственный оркестратор route-attempt держит trusted task lock. Старый
# run_pipeline имел отдельный lock в provider-writable STATE_DIR; его больше нет.
orchestrator_lock_dir="$shared_control/protocol-v2/orchestrators"
mkdir -p "$orchestrator_lock_dir"
exec {orchestrator_fd}>"$orchestrator_lock_dir/t${fixture_task}.lock"
flock "$orchestrator_fd"
lock_error=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" start --profile "$profile_id" \
    --route feature \
    --ticket-json "$ticket" \
    --delivery-target app=main \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
lock_rc=$?
exec {orchestrator_fd}>&-
assert_rc 78 "$lock_rc" "a second route orchestrator loses the trusted task lock"
assert_contains "$lock_error" "оркестратор t${fixture_task} уже работает" \
  "route orchestrator lock conflict remains diagnosable"
assert_file_missing "$shared_state/t${fixture_task}.pipeline" \
  "task lock loser publishes no route registry"

# Недоступный provider обязан закрыть операции, которые реально запускают агентов.
# Проверяем start на отдельной задаче до захвата shared-ресурсов основным
# fixture; ни attempt, ни вторичная pipeline-проекция появиться не должны.
preflight_task=9003
preflight_ticket="$TEST_ROOT/ticket-${preflight_task}.json"
sed "s/\"taskId\": \"$fixture_task\"/\"taskId\": \"$preflight_task\"/" \
  "$ticket" >"$preflight_ticket"
blocked_start=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_PROBE=missing FAKE_BETA_PROBE=missing \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$preflight_task" start --profile "$profile_id" \
    --route feature \
    --ticket-json "$preflight_ticket" \
    --delivery-target app=main \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 1 "$?" "start remains fail-closed when a configured runner is unavailable"
assert_contains "$blocked_start" 'FACTORY_ERROR=runner_preflight_unavailable RUNNERS=alpha' \
  "failed start returns a typed preflight reason with the runner id"
[[ "$blocked_start" != *RUNNERS=alpha,beta* ]]
assert_rc 0 "$?" "start не включает недоступного исполнителя вне узлов маршрута"
assert_file_missing "$shared_state/t${preflight_task}.pipeline" \
  "failed runner preflight creates no route projection"

# Отдельное окно той же TOCTOU: current был валиден на fast check, но исчез до
# authoritative begin. Это доказанный catalog transition в `none`, а не generic
# integrity failure, поэтому очередь может безопасно классифицировать отказ.
missing_task=9005
missing_ticket="$TEST_ROOT/ticket-${missing_task}.json"
sed "s/\"taskId\": \"$fixture_task\"/\"taskId\": \"$missing_task\"/" \
  "$ticket" >"$missing_ticket"
missing_barrier="$TEST_ROOT/catalog-missing-barrier"
missing_output="$TEST_ROOT/catalog-missing.out"
missing_rc_file="$TEST_ROOT/catalog-missing.rc"
missing_dispatch=00000000-0000-4000-8000-000000000004
(
  FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
    FIXTURE_STAND_BARRIER="$missing_barrier" \
    FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
    "$tool" "$missing_task" start --profile "$profile_id" \
      --route feature \
      --ticket-json "$missing_ticket" \
      --runner-primary alpha \
      --expected-catalog-hash "$catalog_initial" \
      --queue-dispatch-id "$missing_dispatch" \
      --delivery-target app=main \
      --routes-dir "$routes" \
      --state-dir "$shared_state" \
      --control-dir "$shared_control" >"$missing_output" 2>&1
  printf '%s\n' "$?" >"$missing_rc_file"
) &
missing_pid=$!
for _ in {1..500}; do
  [[ -e "${missing_barrier}.ready" ]] && break
  sleep 0.02
done
assert_file_exists "${missing_barrier}.ready" \
  "missing-current race reaches the window after fast check"
current_pointer="$routes/$profile_id/catalog/current.json"
current_saved="$TEST_ROOT/current.saved.json"
mv -- "$current_pointer" "$current_saved"
: >"${missing_barrier}.release"
wait "$missing_pid"
mv -- "$current_saved" "$current_pointer"
assert_eq 75 "$(cat "$missing_rc_file")" \
  "authoritative begin types an absent current as catalog_changed"
assert_contains "$(cat "$missing_output")" \
  "FACTORY_ERROR=catalog_changed EXPECTED=$catalog_initial ACTUAL=none" \
  "absent current keeps the stable engine marker"
assert_file_missing "$shared_state/t${missing_task}.pipeline" \
  "absent current leaves no task registry"
missing_root="$shared_control/protocol-v2/tasks/t${missing_task}"
assert_eq 0 \
  "$(find "$missing_root/attempts" -mindepth 1 -maxdepth 1 -type d ! -name '.new.*' | wc -l | tr -d ' ')" \
  "absent current leaves no attempt or pins"
lease_dir="$shared_control/protocol-v2/shared-leases"
assert_eq 0 \
  "$(find "$lease_dir" -maxdepth 1 -type f -name '*.owner' | wc -l | tr -d ' ')" \
  "absent current releases its pending shared leases"

# EC-02: start уже сделал fast check catalog A, затем остановился внутри
# side-effect-free stand health до authoritative attempt begin. Публикуем B в
# этом окне: begin обязан увидеть B под task lock, вернуть typed CAS mismatch и
# не оставить registry/attempt/pins/durable lease.
cas_task=9004
cas_ticket="$TEST_ROOT/ticket-${cas_task}.json"
sed "s/\"taskId\": \"$fixture_task\"/\"taskId\": \"$cas_task\"/" \
  "$ticket" >"$cas_ticket"
cas_barrier="$TEST_ROOT/catalog-cas-barrier"
cas_output="$TEST_ROOT/catalog-cas.out"
cas_rc_file="$TEST_ROOT/catalog-cas.rc"
(
  FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
    FIXTURE_STAND_BARRIER="$cas_barrier" \
    FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
    "$tool" "$cas_task" start --profile "$profile_id" \
      --route feature \
      --ticket-json "$cas_ticket" \
      --runner-primary alpha \
      --expected-catalog-hash "$catalog_initial" \
      --queue-dispatch-id "$dispatch_id" \
      --delivery-target app=main \
      --routes-dir "$routes" \
      --state-dir "$shared_state" \
      --control-dir "$shared_control" >"$cas_output" 2>&1
  printf '%s\n' "$?" >"$cas_rc_file"
) &
cas_pid=$!
for _ in {1..500}; do
  [[ -e "${cas_barrier}.ready" ]] && break
  sleep 0.02
done
assert_file_exists "${cas_barrier}.ready" \
  "catalog race reaches the window after fast check and pending lease claim"
flip_publisher="$FACTORY_TESTS_HOME/fixtures/routes-publish.mjs"
published_flip=$("$NODE_BIN" "$flip_publisher" "$routes" 'Catalog CAS flip' "$catalog_initial")
assert_rc 0 "$?" "catalog B is published inside the start race window"
catalog_flip=$(jq -r '.catalogHash' <<<"$published_flip")
: >"${cas_barrier}.release"
wait "$cas_pid"
assert_eq 75 "$(cat "$cas_rc_file")" \
  "authoritative begin rejects a catalog flipped after the early check"
assert_contains "$(cat "$cas_output")" \
  "FACTORY_ERROR=catalog_changed EXPECTED=$catalog_initial ACTUAL=$catalog_flip" \
  "late catalog flip keeps the typed engine marker"
assert_file_missing "$shared_state/t${cas_task}.pipeline" \
  "catalog CAS mismatch leaves no task registry"
cas_root="$shared_control/protocol-v2/tasks/t${cas_task}"
assert_eq 0 \
  "$(find "$cas_root/attempts" -mindepth 1 -maxdepth 1 -type d ! -name '.new.*' | wc -l | tr -d ' ')" \
  "catalog CAS mismatch leaves no attempt or pins"
lease_dir="$shared_control/protocol-v2/shared-leases"
assert_eq 0 \
  "$(find "$lease_dir" -maxdepth 1 -type f -name '*.owner' | wc -l | tr -d ' ')" \
  "catalog CAS mismatch releases its pending shared leases"

# Возвращаем исходный полный catalog для остальных launcher-contract сценариев.
published_restored=$("$NODE_BIN" "$publisher" "$routes" "$catalog_flip")
assert_rc 0 "$?" "full catalog is restored after the CAS race fixture"
assert_eq "$catalog_initial" "$(jq -r '.catalogHash' <<<"$published_restored")" \
  "content-addressed catalog A is reused after republish"

dispatch_started=00000000-0000-4000-8000-000000000003
shared_start=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" start --profile "$profile_id" \
    --route feature \
    --ticket-json "$ticket" \
    --runner-primary alpha \
    --expected-catalog-hash "$catalog_initial" \
    --queue-dispatch-id "$dispatch_started" \
    --delivery-target app=main \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
shared_start_rc=$?
if (( shared_start_rc != 0 )); then
  test_note "shared start: $shared_start"
  test_note "shared stages: $(cat "$shared_state/logs/t${fixture_task}.stages.log" 2>/dev/null)"
  test_note "shared route: $(cat "$shared_state/logs/t${fixture_task}.route-v2.log" 2>/dev/null)"
  while IFS= read -r diagnostic; do
    test_note "shared diagnostic ${diagnostic#"$shared_state/"}: $(cat "$diagnostic" 2>/dev/null)"
  done < <(find "$shared_state/logs" -type f 2>/dev/null | sort)
fi
assert_rc 0 "$shared_start_rc" "shared mode accepts source equal to the primary checkout"
assert_eq waiting "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "shared run returns at the human plan gate"
assert_file_missing "$TEST_ROOT/shared-up-called" \
  "shared start never calls profile up lifecycle"
attempt=$(awk -F= '$1=="ATTEMPT_ID"{print $2}' "$shared_state/t${fixture_task}.pipeline")
assert_contains "$attempt" 'a_' "shared run publishes its exact attempt id"
attempt_json="$shared_control/protocol-v2/tasks/t${fixture_task}/attempts/$attempt/attempt.json"
assert_eq 2 "$(jq -r '.schema' "$attempt_json")" \
  "launcher publishes the strict launch identity attempt schema"
assert_eq "$catalog_initial" "$(jq -r '.catalogHash' "$attempt_json")" \
  "attempt identity pins the authoritative catalog selected under task lock"
assert_eq "$dispatch_started" "$(jq -r '.queueDispatchId' "$attempt_json")" \
  "attempt identity pins the exact queue dispatch"
assert_eq alpha "$(jq -r '.runnerPrimaryOverride' "$attempt_json")" \
  "attempt identity pins the exact primary runner override"
assert_eq "$catalog_initial" \
  "$(awk -F= '$1=="CATALOG_HASH"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "registry projects catalog identity only from the trusted attempt"
assert_eq "$dispatch_started" \
  "$(awk -F= '$1=="QUEUE_DISPATCH_ID"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "registry projects the trusted dispatch identity"
assert_eq alpha \
  "$(awk -F= '$1=="RUNNER_OVERRIDE_PRIMARY"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "registry projects the trusted runner override"
lease_dir="$shared_control/protocol-v2/shared-leases"
assert_eq 3 "$(find "$lease_dir" -maxdepth 1 -type f -name '*.owner' | wc -l | tr -d ' ')" \
  "workspace, stand and GPU leases persist after foreground exit at a gate"
assert_eq "$attempt" "$(awk -F= '$1=="ATTEMPT"{print $2}' "$lease_dir"/*.owner | sort -u)" \
  "every durable resource lease belongs to the paused exact attempt"

# Ветка закреплена НА РЕПОЗИТОРИЙ и едет в обоих артефактах попытки. Без этого поля
# проект, у которого репозитории стоят на разных ветках, не описать: движку и GrigDesk
# пришлось бы требовать от всех checkout одну ветку — на этом и встала задача 90002.
manifest="$shared_control/protocol-v2/tasks/t${fixture_task}/attempts/$attempt/artifacts/profile-contract.tsv"
assert_eq shared-main "$(awk -F'\t' '$1=="repo" && $2=="app"{print $5}' "$manifest")" \
  "attempt manifest pins the branch of every repository"
assert_eq shared-main "$(awk -F= '$1=="REPO_0_BRANCH"{print $2}' "$shared_state/t${fixture_task}.env")" \
  "run snapshot records the branch per repository"

# Симулируем попытку, начатую launcher-ом до добавления branch в каждую repo-строку.
# Артефакт остаётся immutable во время настоящей попытки; здесь fixture намеренно
# строит его старую форму, чтобы проверить rolling upgrade без перепиновки.
legacy_manifest="$manifest.legacy"
awk -F '\t' 'BEGIN { OFS="\t" } $1=="repo" { NF=4 } { print }' \
  "$manifest" >"$legacy_manifest"
chmod 600 "$manifest"
mv -- "$legacy_manifest" "$manifest"
chmod 400 "$manifest"
legacy_resume=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" resume --profile "$profile_id" --attempt "$attempt" \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 0 "$?" "active attempt with a legacy repo manifest survives launcher upgrade"
assert_eq waiting "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "legacy manifest resume preserves the exact paused cursor"
assert_eq "$catalog_initial" \
  "$(awk -F= '$1=="CATALOG_HASH"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "resume preserves the trusted catalog projection"
assert_eq "$dispatch_started" \
  "$(awk -F= '$1=="QUEUE_DISPATCH_ID"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "resume preserves the predecessor dispatch projection"
assert_eq alpha \
  "$(awk -F= '$1=="RUNNER_OVERRIDE_PRIMARY"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "resume preserves the trusted runner projection"

# Уход shared checkout с закреплённой ветки — это не предупреждение: агент работал бы
# не в том дереве, которое зафиксировал контракт попытки.
git -C "$shared_repo" checkout -qb wandered
drift=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" resume --profile "$profile_id" --attempt "$attempt" \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 78 "$?" "shared checkout moved off its pinned branch stops the attempt"
assert_contains "$drift" 'app стоит на ветке wandered' \
  "branch drift names the repository and the branch it actually sits on"
git -C "$shared_repo" checkout -q shared-main
git -C "$shared_repo" branch -qD wandered

second_task=9002
second_ticket="$TEST_ROOT/ticket-${second_task}.json"
sed "s/\"taskId\": \"$fixture_task\"/\"taskId\": \"$second_task\"/" \
  "$ticket" >"$second_ticket"
collision=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$second_task" start --profile "$profile_id" \
    --route feature \
    --ticket-json "$second_ticket" \
    --delivery-target app=main \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 73 "$?" "second task cannot claim a checkout, stand or GPU held at a gate"
assert_contains "$(cat "$shared_state/logs/t${second_task}.stages.log" 2>/dev/null)" \
  'shared resources уже заняты' \
  "lease collision is reported as shared resource ownership"
assert_file_missing "$shared_state/t${second_task}.pipeline" \
  "lease loser creates no task registry"

# Симулируем crash-window: immutable gate CAS уже записан, а процесс умер до
# вторичной `.pipeline`-проекции. Resume обязан повторить reset из ledger до
# запуска следующего узла.
ledger_only=$(FACTORY_HOME="$FACTORY_HOME" \
  FACTORY_CONTROL_ROOT="$shared_control" \
  FACTORY_ROUTE_STATE_DIR="$shared_state" \
  FACTORY_STATE="$shared_state" STATE_DIR="$shared_state" \
  bash --noprofile --norc -c '
    source "$FACTORY_HOME/lib/attempt-stage-state.sh"
    attempt_stage_state_commit_v2 "$1" "$2" gate_plan rejected
  ' _ "$fixture_task" "$attempt" 2>&1)
ledger_only_rc=$?
assert_rc 0 "$ledger_only_rc" "ledger-only rejection simulates a crash before UI projection"
assert_eq done "$(awk -F= '$1=="PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "crash fixture starts with a deliberately stale pipeline projection"

repair_resume=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" resume --profile "$profile_id" \
    --attempt "$attempt" \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
repair_resume_rc=$?
if (( repair_resume_rc != 0 )); then
  test_note "projection repair resume: $repair_resume"
fi
assert_rc 0 "$repair_resume_rc" "resume repairs an unprojected immutable reset"
assert_eq waiting "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "projection repair reruns the target before pausing at the gate"

# Решение прислали для ворот, на которых курсор НЕ стоит (в закреплённом
# маршруте такого узла вовсе нет). Упавший commit-only обязан сохранить маркер
# остановки: раньше STALLED_HUMAN сбрасывался ещё до CAS, и GrigDesk терял «ждёт
# человека» у стоящего маршрута, дорисовывая ложные ворота дальше по цепочке.
alien_gate=$(FACTORY_FORBID_LIVE=0 \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" gate --profile "$profile_id" \
    --attempt "$attempt" \
    --node gate_accept \
    --decision rejected \
    --commit-only \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 78 "$?" "commit-only gate on a node outside the pinned route refuses early"
assert_eq 1 "$(awk -F= '$1=="STALLED_HUMAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "failed commit-only gate preserves the human-stall marker"
assert_eq waiting "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "failed commit-only gate leaves the paused gate projection untouched"

reject_feedback='уточнить план'
reject_result=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" gate --profile "$profile_id" \
    --attempt "$attempt" \
    --node gate_plan \
    --decision rejected \
    --comment "$reject_feedback" \
    --commit-only \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
reject_rc=$?
if (( reject_rc != 0 )); then
  test_note "rejected gate: $reject_result"
fi
assert_rc 0 "$reject_rc" "rejected gate commits the exact route rewind"
assert_eq pending "$(awk -F= '$1=="PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "route-declared reset returns the plan projection to pending"
assert_eq rejected "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "the just-recorded gate decision remains visible until resume"
assert_eq pending "$(awk -F= '$1=="SHIP"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "nodes outside the rejected gate reset interval remain unchanged"
if grep -q '^TESTS=' "$shared_state/t${fixture_task}.pipeline"; then
  test_fail "generic reset creates no legacy phantom stages" \
    "$(cat "$shared_state/t${fixture_task}.pipeline")"
else
  test_ok "generic reset creates no legacy phantom stages"
fi

changed_retry=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" gate --profile "$profile_id" \
    --attempt "$attempt" \
    --node gate_plan \
    --decision rejected \
    --comment 'другое замечание после crash-retry' \
    --commit-only \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 75 "$?" "changed rejected feedback loses exact idempotency CAS"
assert_eq "$reject_feedback" \
  "$(awk -F= '$1=="GATE_PLAN_COMMENT"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "conflicting gate retry cannot project text absent from the ledger"

# После rewind курсор стоит на plan, а решение повторно
# прислали для gate_plan. CAS на устаревшем узле ворот — ровно код 75, и
# записанное ранее решение остаётся видимым.
stale_gate=$(FACTORY_FORBID_LIVE=0 \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" gate --profile "$profile_id" \
    --attempt "$attempt" \
    --node gate_plan \
    --decision approved \
    --commit-only \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 75 "$?" "stale gate cursor refuses the commit-only CAS"
assert_eq rejected "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "stale gate refusal keeps the recorded decision visible"

rejected_prompt="$TEST_ROOT/rejected-gate.prompt"
resume_result=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FAKE_ALPHA_PROMPT_FILE="$rejected_prompt" \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" resume --profile "$profile_id" \
    --attempt "$attempt" \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
resume_rc=$?
if (( resume_rc != 0 )); then
  test_note "resume after rejected gate: $resume_result"
fi
assert_rc 0 "$resume_rc" "resume reruns the exact reset interval"
assert_eq done "$(awk -F= '$1=="PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "rewound plan executes again"
assert_eq waiting "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "rerun pauses at a fresh plan decision"
assert_eq "" "$(awk -F= '$1=="GATE_PLAN_COMMENT"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "resume may clear the mutable gate comment projection"
assert_file_exists "$rejected_prompt" \
  "rewound agent prompt is captured after a separate resume"
assert_contains "$(cat "$rejected_prompt")" \
  '## Указание человека при возврате на этот узел' \
  "separate resume delivers rejected feedback through the priority human block"
assert_contains "$(cat "$rejected_prompt")" "$reject_feedback" \
  "separate resume preserves the exact rejected feedback text"

gate_result=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_PROBE=missing FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" gate --profile "$profile_id" \
    --attempt "$attempt" \
    --node gate_plan \
    --decision approved \
    --commit-only \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
gate_rc=$?
if (( gate_rc != 0 )); then
  test_note "commit-only gate: $gate_result"
  test_note "gate stages: $(cat "$shared_state/logs/t${fixture_task}.stages.log" 2>/dev/null)"
  test_note "gate route: $(cat "$shared_state/logs/t${fixture_task}.route-v2.log" 2>/dev/null)"
fi
assert_rc 0 "$gate_rc" "commit-only gate verifies and preserves the exact shared lease"
assert_eq "$attempt" "$(awk -F= '$1=="ATTEMPT"{print $2}' "$lease_dir"/*.owner | sort -u)" \
  "human decision does not release shared resources before resumed work"

# То же состояние с тем же сломанным probe: решение уже записано, но resume
# обязан остановиться до нового agent run. Именно эта асимметрия потерялась в
# инциденте, когда общий preflight ошибочно стоял перед gate --commit-only.
blocked_resume=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_PROBE=missing FAKE_BETA_PROBE=missing \
  FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" resume --profile "$profile_id" --attempt "$attempt" \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 1 "$?" "resume remains fail-closed after a commit-only gate"
assert_contains "$blocked_resume" 'FACTORY_ERROR=runner_preflight_unavailable RUNNERS=alpha' \
  "failed resume returns a typed preflight reason with the runner id"
[[ "$blocked_resume" != *RUNNERS=alpha,beta* ]]
assert_rc 0 "$?" "resume не включает недоступного исполнителя вне достижимых узлов"
assert_eq approved "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "failed resume preserves the already committed human decision"

# Слишком длинная причина — самая частая ошибка человека за CLI и в модалке GrigDesk.
# Отказ обязан прийти ДО локов и проекции, с названной границей: GrigDesk показывает
# человеку именно этот текст движка (routeMessage в server/src/lib/factory-route-cli.js).
plan_before=$(awk -F= '$1=="PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")
long_reason=$(python3 -c 'print("щ" * 20001, end="")')
long_goto=$(FACTORY_FORBID_LIVE=0 \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" goto --profile "$profile_id" \
    --attempt "$attempt" \
    --node plan \
    --reason "$long_reason" \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 2 "$?" "goto refuses a reason over the limit"
assert_contains "$long_goto" 'допустимо 1..20000' \
  "the refusal names the violated rule instead of a bare exit code"
assert_eq "$plan_before" \
  "$(awk -F= '$1=="PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "a refused reason leaves the projection untouched"

goto_result=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" goto --profile "$profile_id" \
    --attempt "$attempt" \
    --node plan \
    --reason 'проверить новую формулировку' \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
goto_rc=$?
if (( goto_rc != 0 )); then
  test_note "human goto: $goto_result"
fi
assert_rc 0 "$goto_rc" "human goto commits a trusted route reset"
assert_eq pending "$(awk -F= '$1=="PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "goto resets its target runKey from the pinned machine"
assert_eq pending "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "goto resets the downstream gate without a fixed stage list"
assert_eq pending "$(awk -F= '$1=="PLAN_DECISION"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "goto clears the stale GrigDesk decision projection"
assert_eq '' "$(awk -F= '$1=="GATE_PLAN_COMMENT"{sub(/^[^=]*=/, ""); print}' "$shared_state/t${fixture_task}.pipeline")" \
  "goto clears the stale rejected-gate comment"

FACTORY_FORBID_LIVE=0 \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" abandon --profile "$profile_id" \
    --attempt "$attempt" \
    --reason 'fixture cleanup' \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" >/dev/null 2>&1
assert_rc 0 "$?" "abandon releases leases owned by the exact shared attempt"
assert_eq 0 "$(find "$lease_dir" -maxdepth 1 -type f -name '*.owner' | wc -l | tr -d ' ')" \
  "shared leases are removed only by explicit attempt termination"
assert_file_missing "$TEST_ROOT/shared-down-called" \
  "shared abandon never calls profile down lifecycle"
assert_eq baseline "$(cat "$shared_repo/tracked.txt")" \
  "shared checkout remains intact after start, gate and abandon"

# Recover — это новый run, поэтому он берёт fresh current catalog и сохраняет
# runner policy задачи, но никогда не наследует queue dispatch предшественницы.
recovery_output=$(FACTORY_FORBID_LIVE=0 \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" recover --profile "$profile_id" \
    --attempt "$attempt" \
    --reason 'fixture queue provenance recovery' \
    --route feature \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
recovery_rc=$?
if (( recovery_rc != 0 )); then
  test_note "queue provenance recovery: $recovery_output"
fi
assert_rc 0 "$recovery_rc" "recover creates a distinct run after queued predecessor"
recovery_attempt=$(tail -n 1 <<<"$recovery_output")
assert_contains "$recovery_attempt" 'a_' "recover reports the new exact attempt id"
recovery_json="$shared_control/protocol-v2/tasks/t${fixture_task}/attempts/$recovery_attempt/attempt.json"
assert_eq "$dispatch_started" "$(jq -r '.queueDispatchId' "$attempt_json")" \
  "recovery does not mutate predecessor queue provenance"
assert_eq null "$(jq -r '.queueDispatchId' "$recovery_json")" \
  "recovery has no queue dispatch provenance"
assert_eq alpha "$(jq -r '.runnerPrimaryOverride' "$recovery_json")" \
  "recovery preserves the trusted task-level runner override"
assert_eq "$catalog_initial" "$(jq -r '.catalogHash' "$recovery_json")" \
  "recovery pins fresh current catalog in its own trusted identity"
assert_eq "$catalog_initial" \
  "$(awk -F= '$1=="CATALOG_HASH"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "recovery registry projects its own trusted catalog"
assert_eq "" \
  "$(awk -F= '$1=="QUEUE_DISPATCH_ID"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "recovery registry clears stale queue provenance"
assert_eq alpha \
  "$(awk -F= '$1=="RUNNER_OVERRIDE_PRIMARY"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "recovery registry retains the trusted runner override"

FACTORY_FORBID_LIVE=0 \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" abandon --profile "$profile_id" \
    --attempt "$recovery_attempt" \
    --reason 'recovery fixture cleanup' \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" >/dev/null 2>&1
assert_rc 0 "$?" "recovery fixture releases its exact shared leases"
assert_eq 0 "$(find "$lease_dir" -maxdepth 1 -type f -name '*.owner' | wc -l | tr -d ' ')" \
  "recovery cleanup leaves no durable resource lease"

# Попытка, начатая до появления lifecycle-журнала, не имеет в нём НИ ОДНОГО события.
# Первым событием журнала обязан идти route_selected, поэтому открытая на abandon сессия
# со scoped route identity отвергалась схемой («scoped route identity appears before
# route_selected»), и operator-действия старой попытки — снос стенда, resume, goto —
# падали кодом 78 детерминированно: у человека переставала работать кнопка.
legacy_output=$(FACTORY_FORBID_LIVE=0 \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" recover --profile "$profile_id" \
    --attempt "$recovery_attempt" \
    --reason 'fixture attempt without lifecycle ledger' \
    --route feature \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
legacy_rc=$?
if (( legacy_rc != 0 )); then
  test_note "legacy lifecycle recover: $legacy_output"
fi
assert_rc 0 "$legacy_rc" "recover creates the attempt used for the pre-ledger case"
legacy_attempt=$(tail -n 1 <<<"$legacy_output")
legacy_dir="$shared_control/protocol-v2/tasks/t${fixture_task}/attempts/$legacy_attempt"
rm -rf "$legacy_dir/lifecycle"

legacy_abandon=$(FACTORY_FORBID_LIVE=0 \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" abandon --profile "$profile_id" \
    --attempt "$legacy_attempt" \
    --reason 'pre-ledger fixture cleanup' \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
legacy_rc=$?
if (( legacy_rc != 0 )); then
  test_note "legacy lifecycle abandon: $legacy_abandon"
fi
assert_rc 0 "$legacy_rc" "abandon closes an attempt that predates the lifecycle ledger"
assert_eq 0 \
  "$(cat "$legacy_dir"/lifecycle/segments/*.ndjson 2>/dev/null | wc -l | tr -d ' ')" \
  "a pre-ledger attempt gets no invented lifecycle history"

assert_file_missing "$FACTORY_HOME/bin/factory-canary" \
  "obsolete special launcher is removed"
assert_file_missing "$FACTORY_HOME/bin/factory-canary-host.mjs" \
  "obsolete host wrapper is removed"

# Читает только через штатный валидатор из отдельного shell-процесса.
pending_public_lifecycle() {
  local item_task=$1 item_attempt=$2 item_state=$3 item_control=$4
  FACTORY_CONTROL_ROOT="$item_control" FACTORY_ROUTE_STATE_DIR="$item_state" \
    STATE_DIR="$item_state" bash --noprofile --norc -c '
      source "$FACTORY_HOME/lib/attempt-lifecycle-state.sh" || exit $?
      attempt_lifecycle_read_v2 "$1" "$2"
    ' _ "$item_task" "$item_attempt"
}

# Expected задаётся по реальному source visit/стадийному hash, не из нового human record.
pending_assert_human() {
  python3 - "$@" <<'PYCODE'
import json
import sys
from pathlib import Path
file_name, visit, source_session, stage_hash, mode, finished_count = sys.argv[1:]
rows = [json.loads(line) for line in Path(file_name).read_text().splitlines()]
starts = [row for row in rows if row['kind'] == 'node_visit_started' and row['nodeVisitId'] == visit]
assert len(starts) == 1
assert starts[0]['orchestratorSessionId'] == source_session
humans = [row for row in rows if row['kind'] == 'human_intervention_started']
assert len(humans) == 1
human = humans[0]
assert human['nodeVisitId'] == visit
assert human['nodeId'] == 'verify' and human['runKey'] == 'VERIFY'
assert human['details']['evidenceSha256'] == stage_hash
assert human['details']['reasonCode'] == 'manual_resume_required'
assert sum(row['kind'] == 'node_visit_finished' for row in rows) == int(finished_count)
assert not any(row['kind'] == 'human_intervention_resolved' for row in rows)
if mode == 'existing':
    assert human['orchestratorSessionId'] == source_session
else:
    assert human['orchestratorSessionId'] != source_session
PYCODE
}

# Проверяет реальные артефакты целиком, включая прежний fail-closed перед recovery.
pending_assert_stall() {
  local item_task=$1 item_state=$2 label=$3 consumer_log rc
  consumer_log="$TEST_ROOT/stall-consumer-$label.log"
  PENDING_RECOVERY_STAGES_PATH="$item_state/logs/t${item_task}.stages.log" \
  PENDING_RECOVERY_PIPELINE_PATH="$item_state/t${item_task}.pipeline" \
  PENDING_RECOVERY_MACHINE_PATH="$TEST_ROOT/pending-command-machine.json" \
  PATH="$(dirname "$NODE_BIN"):$PATH" \
  NODE_TEST_MAX_RSS_MB=4096 bash "$FACTORY_TESTS_HOME/../run-node-tests-safe.sh" \
    --test-concurrency=2 --test "$FACTORY_TESTS_HOME/../server/stall-human-stop.test.js" \
    >"$consumer_log" 2>&1
  rc=$?
  if (( rc != 0 )); then test_note "$(cat "$consumer_log")"; fi
  assert_rc 0 "$rc" "$label: actual log → карточка VERIFY/human/готово и graph key"
}

gap_routes="$TEST_ROOT/pending-launcher-routes"
"$NODE_BIN" --input-type=module - "$FACTORY_HOME/.." "$gap_routes" \
  "$TEST_ROOT/pending-command-machine.json" <<'JS'
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [root, baseDir, machinePath] = process.argv.slice(2);
const { RoutesStore } = await import(pathToFileURL(`${root}/server/src/modules/routes/store.ts`));
const fixtures = await import(pathToFileURL(`${root}/tests/engine/fixtures/routes-catalog-definitions.mjs`));
const definition = structuredClone(fixtures.ROUTE_DEFINITIONS.command);
definition.route.bootstrap = 'skip';
definition.route.entry = 'verify';
const verify = definition.route.nodes.find(node => node.id === 'verify');
verify.on.done = { stop: 'human' };
verify.on.skipped = { next: 'retro' };
await fs.writeFile(machinePath, JSON.stringify(definition.route));
const store = new RoutesStore({ baseDir });
const published = await store.publishRoute(fixtures.PROFILE_ID, 'command', definition);
const bootstrap = structuredClone(fixtures.bootstrap);
bootstrap.nodes[0].on.done.escalate.routes = ['command'];
bootstrap.escalation[0].allowedRoutes = ['command'];
await store.publishCatalog(fixtures.PROFILE_ID, {
  catalog: {
    schema: 2, profile: fixtures.PROFILE_ID,
    routes: { command: published.routeHash }, bootstrap: { file: 'bootstrap/scout.json' },
  },
  bootstrap, prompts: fixtures.bootstrapPrompts,
}, { expectedCatalogHash: null });
JS
assert_rc 0 "$?" 'public gap: настоящий bundle опубликован в temporary store'
cp "$profile_dir/profile.sh" "$TEST_ROOT/profile-before-pending-test.sh"
cat >>"$profile_dir/profile.sh" <<'PROFILE'
profile_route_command() {
  [[ "$2" == command && "$3" == verify && "$5" == fixture-verify ]] || return 64
  if [[ "${FIXTURE_RUNTIME_FAULT:-0}" == 1 ]]; then
    # Hook выполняется в host после загрузки runtime, fault только у следующего commit.
    _attempt_stage_state_publish_runtime_locked() { return 74; }
  fi
  printf '%s\n' '{"schema":1,"outcome":"done","comment":"готово","failureOwner":null,"findings":[]}'
}
PROFILE
public_gap_task=9018
public_gap_ticket="$TEST_ROOT/pending-ticket.json"
sed "s/\"taskId\": \"$fixture_task\"/\"taskId\": \"$public_gap_task\"/"   "$ticket" >"$public_gap_ticket"
public_gap_state="$TEST_ROOT/pending-public-state"
public_gap_control="$TEST_ROOT/pending-public-control"
before_invocations=$(wc -l <"$TEST_ROOT/invocations")
public_gap_start=$(FACTORY_FORBID_LIVE=0 FIXTURE_RUNTIME_FAULT=1 FAKE_ALPHA_RESULT=done   FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"   "$tool" "$public_gap_task" start --profile "$profile_id" --route command     --ticket-json "$public_gap_ticket" --routes-dir "$gap_routes"     --state-dir "$public_gap_state" --control-dir "$public_gap_control" 2>&1)
assert_rc 74 "$?" 'public gap: исходный start остановился именно после event publication'
public_gap_attempt=$(awk -F= '$1=="ATTEMPT_ID"{print $2}'   "$public_gap_state/t${public_gap_task}.pipeline")
public_gap_dir="$public_gap_control/protocol-v2/tasks/t${public_gap_task}/attempts/$public_gap_attempt"
assert_file_exists "$public_gap_dir/pending-transition.json" 'public gap: durable receipt существует'
old_events=$(find "$public_gap_dir/stage-results" -name 'event.*.json' | wc -l)
origin_visit=$(jq -r .origin.nodeVisitId "$public_gap_dir/pending-transition.json")
origin_session=$(jq -r .origin.orchestratorSessionId "$public_gap_dir/pending-transition.json")
pending_public_lifecycle "$public_gap_task" "$public_gap_attempt" \
  "$public_gap_state" "$public_gap_control" >"$TEST_ROOT/public-gap-before.ndjson"
source_finished=$(python3 - "$TEST_ROOT/public-gap-before.ndjson" <<'PYCODE'
import json
import sys
from pathlib import Path
print(sum(json.loads(line)['kind'] == 'node_visit_finished'
          for line in Path(sys.argv[1]).read_text().splitlines()))
PYCODE
)
cp "$public_gap_dir/pending-transition.json" "$TEST_ROOT/public-pending-original.json"
for bad in task origin; do
  before_bad_runtime=$(sha256sum "$public_gap_dir/stage-results/runtime.json" | cut -d' ' -f1)
  before_bad_lifecycle=$(pending_public_lifecycle "$public_gap_task" "$public_gap_attempt" \
    "$public_gap_state" "$public_gap_control" | sha256sum)
  chmod 600 "$public_gap_dir/pending-transition.json"
  python3 - "$public_gap_dir/pending-transition.json" "$bad" <<'PYCODE'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
value = json.loads(path.read_text())
if sys.argv[2] == 'task':
    value['base']['taskId'] = '8'
else:
    value['origin']['nodeVisitId'] = 'nv_' + '9' * 32
path.write_text(json.dumps(value))
path.chmod(0o400)
PYCODE
  FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
    FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
    "$tool" "$public_gap_task" resume --profile "$profile_id" --attempt "$public_gap_attempt" \
      --routes-dir "$gap_routes" --state-dir "$public_gap_state" \
      --control-dir "$public_gap_control" >/dev/null 2>&1
  assert_rc 78 "$?" "public gap: wrong $bad отклонён до восстановительных эффектов"
  assert_eq "$before_bad_runtime" \
    "$(sha256sum "$public_gap_dir/stage-results/runtime.json" | cut -d' ' -f1)" \
    "public gap: wrong $bad не меняет pointer"
  assert_eq "$before_bad_lifecycle" \
    "$(pending_public_lifecycle "$public_gap_task" "$public_gap_attempt" \
      "$public_gap_state" "$public_gap_control" | sha256sum)" "public gap: wrong $bad не пишет lifecycle"
  assert_eq "$before_invocations" "$(wc -l <"$TEST_ROOT/invocations")" 'public gap: негатив без модели'
  assert_eq "$old_events" "$(find "$public_gap_dir/stage-results" -name 'event.*.json' | wc -l)" \
    'public gap: негатив не меняет stage ledger'
  chmod 600 "$public_gap_dir/pending-transition.json"
  cat "$TEST_ROOT/public-pending-original.json" >"$public_gap_dir/pending-transition.json"
  chmod 400 "$public_gap_dir/pending-transition.json"
done
public_gap_resume=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done   FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"   "$tool" "$public_gap_task" resume --profile "$profile_id" --attempt "$public_gap_attempt"     --routes-dir "$gap_routes" --state-dir "$public_gap_state"     --control-dir "$public_gap_control" 2>&1)
public_gap_rc=$?
if (( public_gap_rc != 0 )); then test_note "$public_gap_resume"; fi
assert_rc 0 "$public_gap_rc" 'public gap: штатный factory resume достиг восстановления'
assert_eq "$old_events"   "$(find "$public_gap_dir/stage-results" -name 'event.*.json' | wc -l)"   'public gap: accepted command не создал повторное stage event'
assert_eq "$before_invocations" "$(wc -l <"$TEST_ROOT/invocations")"   'public gap: preflight и resume не запустили ни одной модели'
assert_file_missing "$public_gap_dir/pending-transition.json" 'public gap: replay receipt погашен'
public_gap_cursor=$(FACTORY_CONTROL_ROOT="$public_gap_control"   FACTORY_ROUTE_STATE_DIR="$public_gap_state" STATE_DIR="$public_gap_state"   bash --noprofile --norc -c '
    source "$FACTORY_HOME/lib/attempt-stage-state.sh"
    attempt_stage_state_read_v2 "$1" "$2"
  ' _ "$public_gap_task" "$public_gap_attempt")
assert_rc 0 "$?" 'public gap: восстановленная цепочка проходит общий строгий read'
assert_eq human "$(jq -r .stop <<<"$public_gap_cursor")" 'public gap: сохранён точный stop'
assert_eq verify "$(jq -r .lastCommit.node <<<"$public_gap_cursor")" 'public gap: последнее решение command'
pending_public_lifecycle "$public_gap_task" "$public_gap_attempt" \
  "$public_gap_state" "$public_gap_control" >"$TEST_ROOT/public-gap-after.ndjson"
pending_assert_human "$TEST_ROOT/public-gap-after.ndjson" "$origin_visit" "$origin_session" \
  "$(jq -r .headEventHash <<<"$public_gap_cursor")" new "$source_finished"
assert_rc 0 "$?" 'public gap: один correct human record, source visit, новая writer session'
pending_assert_stall "$public_gap_task" "$public_gap_state" gap-first
before_repeat=$(pending_public_lifecycle "$public_gap_task" "$public_gap_attempt" \
  "$public_gap_state" "$public_gap_control" | sha256sum)
FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$public_gap_task" resume --profile "$profile_id" --attempt "$public_gap_attempt" \
    --routes-dir "$gap_routes" --state-dir "$public_gap_state" \
    --control-dir "$public_gap_control" >/dev/null
assert_rc 0 "$?" 'public gap: повтор восстановленного stop удержан штатно'
assert_eq "$before_repeat" "$(pending_public_lifecycle "$public_gap_task" "$public_gap_attempt" \
  "$public_gap_state" "$public_gap_control" | sha256sum)" 'public gap: повтор не открывает session/human'
assert_eq "$before_invocations" "$(wc -l <"$TEST_ROOT/invocations")" 'public gap: повтор без модели'
pending_assert_stall "$public_gap_task" "$public_gap_state" gap-repeat
# Явная штатная очистка собственной fake shared lease, чтобы fixture не оставляла владельца.
FACTORY_FORBID_LIVE=0 FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"   "$tool" "$public_gap_task" abandon --profile "$profile_id" --attempt "$public_gap_attempt"     --reason 'offline pending fixture complete' --routes-dir "$gap_routes"     --state-dir "$public_gap_state" --control-dir "$public_gap_control" >/dev/null
assert_rc 0 "$?" 'public gap: собственная fake lease освобождена'
cp "$TEST_ROOT/profile-before-pending-test.sh" "$profile_dir/profile.sh"

cp "$profile_dir/profile.sh" "$TEST_ROOT/profile-before-human-fault.sh"
cat >>"$profile_dir/profile.sh" <<'PROFILE'
profile_route_command() {
  [[ "$2" == command && "$3" == verify && "$5" == fixture-verify ]] || return 64
  if [[ -n "${FIXTURE_HUMAN_FAULT:-}" ]]; then
    eval "$(declare -f runtime_lifecycle_human_begin_v2 | \
      sed '1s/runtime_lifecycle_human_begin_v2/_human_begin_without_fixture_fault/')"
    runtime_lifecycle_human_begin_v2() {
      if [[ "$FIXTURE_HUMAN_FAULT" == before ]]; then return 74; fi
      _human_begin_without_fixture_fault "$@" || return
      return 74
    }
  fi
  printf '%s\n' '{"schema":1,"outcome":"done","comment":"готово","failureOwner":null,"findings":[]}'
}
PROFILE
human_task=9030
for failure in before after; do
  human_task=$((human_task + 1))
  human_state="$TEST_ROOT/pending-human-$failure-state"
  human_control="$TEST_ROOT/pending-human-$failure-control"
  human_ticket="$TEST_ROOT/pending-human-$failure-ticket.json"
  sed "s/\"taskId\": \"$fixture_task\"/\"taskId\": \"$human_task\"/" "$ticket" >"$human_ticket"
  model_count=$(wc -l <"$TEST_ROOT/invocations")
  human_start=$(FACTORY_FORBID_LIVE=0 FIXTURE_HUMAN_FAULT="$failure" FAKE_ALPHA_RESULT=done \
    FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
    "$tool" "$human_task" start --profile "$profile_id" --route command \
      --ticket-json "$human_ticket" --routes-dir "$gap_routes" \
      --state-dir "$human_state" --control-dir "$human_control" 2>&1)
  assert_rc 74 "$?" "human $failure: fault находится в human projection"
  human_attempt=$(awk -F= '$1=="ATTEMPT_ID"{print $2}' "$human_state/t${human_task}.pipeline")
  human_dir="$human_control/protocol-v2/tasks/t${human_task}/attempts/$human_attempt"
  assert_file_exists "$human_dir/pending-transition.json" "human $failure: receipt пережил отказ"
  source_visit=$(jq -r .origin.nodeVisitId "$human_dir/pending-transition.json")
  source_session=$(jq -r .origin.orchestratorSessionId "$human_dir/pending-transition.json")
  accepted_hash=$(jq -r .runtime.headEventHash "$human_dir/stage-results/runtime.json")
  accepted_events=$(find "$human_dir/stage-results" -name 'event.*.json' | wc -l)
  pending_public_lifecycle "$human_task" "$human_attempt" "$human_state" "$human_control" \
    >"$TEST_ROOT/human-$failure-before.ndjson"
  if [[ "$failure" == after ]]; then mode=existing; else mode=new; fi
  human_resume=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
    FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
    "$tool" "$human_task" resume --profile "$profile_id" --attempt "$human_attempt" \
      --routes-dir "$gap_routes" --state-dir "$human_state" --control-dir "$human_control" 2>&1)
  resume_rc=$?
  if (( resume_rc != 0 )); then test_note "$human_resume"; fi
  assert_rc 0 "$resume_rc" "human $failure: отдельный public resume завершил проекцию"
  assert_file_missing "$human_dir/pending-transition.json" "human $failure: ack после успеха"
  assert_eq "$accepted_events" "$(find "$human_dir/stage-results" -name 'event.*.json' | wc -l)" \
    "human $failure: stage event не дублируется"
  assert_eq "$model_count" "$(wc -l <"$TEST_ROOT/invocations")" "human $failure: нет модели"
  pending_public_lifecycle "$human_task" "$human_attempt" "$human_state" "$human_control" \
    >"$TEST_ROOT/human-$failure-after.ndjson"
  pending_assert_human "$TEST_ROOT/human-$failure-after.ndjson" "$source_visit" \
    "$source_session" "$accepted_hash" "$mode" 1
  assert_rc 0 "$?" "human $failure: один human, exact source, один visit finish"
  pending_assert_stall "$human_task" "$human_state" "human-$failure-first"
  if [[ "$failure" == after ]]; then
    python3 - "$TEST_ROOT/human-after-before.ndjson" "$TEST_ROOT/human-after-after.ndjson" <<'PYCODE'
import json
import sys
from pathlib import Path
before, after = [[json.loads(line) for line in Path(name).read_text().splitlines()] for name in sys.argv[1:]]
original = [row for row in before if row['kind'] == 'human_intervention_started']
replayed = [row for row in after if row['kind'] == 'human_intervention_started']
assert original == replayed and len(original) == 1
PYCODE
    assert_rc 0 "$?" 'human after: original human event не переписан'
  fi
  stable_lifecycle=$(pending_public_lifecycle "$human_task" "$human_attempt" \
    "$human_state" "$human_control" | sha256sum)
  FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
    FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
    "$tool" "$human_task" resume --profile "$profile_id" --attempt "$human_attempt" \
      --routes-dir "$gap_routes" --state-dir "$human_state" --control-dir "$human_control" >/dev/null
  assert_rc 0 "$?" "human $failure: повтор удержан без lifecycle error"
  assert_eq "$stable_lifecycle" "$(pending_public_lifecycle "$human_task" "$human_attempt" \
    "$human_state" "$human_control" | sha256sum)" "human $failure: нет новой session/resolve/human"
  assert_eq "$model_count" "$(wc -l <"$TEST_ROOT/invocations")" "human $failure: повтор без модели"
  pending_assert_stall "$human_task" "$human_state" "human-$failure-repeat"
  FACTORY_FORBID_LIVE=0 FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
    "$tool" "$human_task" abandon --profile "$profile_id" --attempt "$human_attempt" \
      --reason 'offline human projection fixture complete' --routes-dir "$gap_routes" \
      --state-dir "$human_state" --control-dir "$human_control" >/dev/null
  assert_rc 0 "$?" "human $failure: fake lease освобождена"
done
cp "$TEST_ROOT/profile-before-human-fault.sh" "$profile_dir/profile.sh"

finish_tests
