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
  MODEL_DEFAULT_ALPHA_FAMILY=fixture \
  MODEL_DEFAULT_ALPHA_VERSION=latest \
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

"$NODE_BIN" "$publisher" "$routes" null >/dev/null
assert_rc 0 "$?" "route source publishes for launcher contract"

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
assert_contains "$source_text" 'RUNNER_OVERRIDE_PRIMARY "$RUNNER_PRIMARY_OVERRIDE"' \
  "task-level override reaches the registry only from the explicit flag"
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
  "plan gate has a compatibility projection for Cockpit"
assert_contains "$source_text" "gate_cause) printf 'GATE_CAUSE" \
  "cause gate has a compatibility projection for Cockpit"
assert_contains "$source_text" "gate_accept) printf 'GATE_ACCEPT" \
  "acceptance gate has a compatibility projection for Cockpit"
assert_contains "$source_text" '"$pipeline_gate_key" "$GATE_DECISION"' \
  "accepted or rejected gate decisions are projected to Cockpit"
assert_contains "$source_text" '"$pipeline_gate_key" waiting STALLED_HUMAN 1' \
  "a paused trusted cursor is projected as a waiting Cockpit gate"
# Синхронному вызывающему (кокпит по HTTP) нужен выход сразу после фиксации:
# иначе gate ведёт маршрут дальше и переживает чужой таймаут только сиротой.
# Снятие STALLED_HUMAN — строго ПОСЛЕ CAS: упавший commit-only не имеет права
# стирать маркер остановки у стоящего маршрута.
assert_contains "$source_text" 'v2_gate_commit "$attempt" || return
    set_st "$TASK" STALLED_HUMAN 0 || return
    return 0' \
  "--commit-only records the decision and leaves the route to a separate resume"
assert_contains "$source_text" 'GATE_COMMIT_ONLY" == 1 ]] ||' \
  "commit-only is rejected outside the gate mode"
# Реестр читает не только кокпит, но и агенты: иначе PLAN может увидеть в нём
# TESTS=done от отменённой попытки и пойти искать несуществующие тесты.
assert_contains "$source_text" 'set_st "$TASK" --init --stages "$(v2_registry_stage_keys "$new_catalog")"' \
  "recovery re-inits the registry from the newly pinned catalog"
assert_contains "$source_text" 'v2_quarantine_state_artifacts "$EXPECTED_ATTEMPT" || return' \
  "recovery takes the predecessor stage artifacts off the disk"

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
profile_stand_alive() { return 0; }
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
blocked_start=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_PROBE=missing \
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
assert_file_missing "$shared_state/t${preflight_task}.pipeline" \
  "failed runner preflight creates no route projection"

shared_start=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" start --profile "$profile_id" \
    --route feature \
    --ticket-json "$ticket" \
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
assert_eq "" "$(awk -F= '$1=="RUNNER_OVERRIDE_PRIMARY"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "shared run without --runner-primary leaves provider selection to runners.env"
lease_dir="$shared_control/protocol-v2/shared-leases"
assert_eq 3 "$(find "$lease_dir" -maxdepth 1 -type f -name '*.owner' | wc -l | tr -d ' ')" \
  "workspace, stand and GPU leases persist after foreground exit at a gate"
assert_eq "$attempt" "$(awk -F= '$1=="ATTEMPT"{print $2}' "$lease_dir"/*.owner | sort -u)" \
  "every durable resource lease belongs to the paused exact attempt"

# Ветка закреплена НА РЕПОЗИТОРИЙ и едет в обоих артефактах попытки. Без этого поля
# проект, у которого репозитории стоят на разных ветках, не описать: движку и кокпиту
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
# остановки: раньше STALLED_HUMAN сбрасывался ещё до CAS, и кокпит терял «ждёт
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
blocked_resume=$(FACTORY_FORBID_LIVE=0 FAKE_ALPHA_PROBE=missing FAKE_ALPHA_RESULT=done \
  FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners" \
  "$tool" "$fixture_task" resume --profile "$profile_id" --attempt "$attempt" \
    --routes-dir "$routes" \
    --state-dir "$shared_state" \
    --control-dir "$shared_control" 2>&1)
assert_rc 1 "$?" "resume remains fail-closed after a commit-only gate"
assert_contains "$blocked_resume" 'FACTORY_ERROR=runner_preflight_unavailable RUNNERS=alpha' \
  "failed resume returns a typed preflight reason with the runner id"
assert_eq approved "$(awk -F= '$1=="GATE_PLAN"{print $2}' "$shared_state/t${fixture_task}.pipeline")" \
  "failed resume preserves the already committed human decision"

# Слишком длинная причина — самая частая ошибка человека за CLI и в модалке кокпита.
# Отказ обязан прийти ДО локов и проекции, с названной границей: кокпит показывает
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
  "goto clears the stale Cockpit decision projection"
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

assert_file_missing "$FACTORY_HOME/bin/factory-canary" \
  "obsolete special launcher is removed"
assert_file_missing "$FACTORY_HOME/bin/factory-canary-host.mjs" \
  "obsolete host wrapper is removed"

finish_tests
