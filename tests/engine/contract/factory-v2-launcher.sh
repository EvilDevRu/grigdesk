#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

tool="$FACTORY_HOME/bin/factory-v2"
routes="$TEST_ROOT/routes-v2"
publisher="$FACTORY_TESTS_HOME/fixtures/routes-v2-catalog-publish.mjs"
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
  >"$profile_dir/runners.env"
printf '%s\n' '{"capabilities":["route-v2"]}' >"$profile_dir/graph.json"

"$NODE_BIN" "$publisher" "$routes" null >/dev/null
assert_rc 0 "$?" "route source publishes for launcher contract"

for route in debug feature trivial; do
  output=$("$tool" check --profile "$profile_id" --route "$route" --routes-dir "$routes")
  assert_rc 0 "$?" "launcher validates route=$route without a task launch"
  assert_contains "$output" "route=$route" \
    "check reports the validated route"
done

source_text=$(cat "$tool")
case "$source_text" in
  *factory-v2-canary*|*canary-no-publish*|*FACTORY_CANARY*)
    test_fail "launcher contains no separate rollout runtime"
    ;;
  *)
    test_ok "launcher contains no separate rollout runtime"
    ;;
esac
case "$source_text" in
  *RUNNER_OVERRIDE_PRIMARY*|*RUNNER_OVERRIDE_FAILOVER*)
    test_fail "launcher must not override runners.env"
    ;;
  *)
    test_ok "launcher leaves provider selection to runners.env"
    ;;
esac
assert_contains "$source_text" "profile_runner_host_preflight" \
  "launcher verifies the configured provider chain"
assert_contains "$source_text" "for action in commit push pull-request" \
  "typed context grants SHIP commit, push and pull-request creation"
assert_contains "$source_text" "FACTORY_SANDBOX_GENERATION=v2" \
  "start requests a fresh v2 sandbox generation"
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
assert_contains "$source_text" 'v2_gate_commit "$attempt" || return
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

"$tool" "$fixture_task" start --profile "$profile_id" \
  --route feature \
  --ticket-json "$ticket" \
  --routes-dir "$routes" \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" \
  --legacy-state-dir "$STATE_DIR" >/dev/null 2>&1
assert_rc 78 "$?" "offline harness blocks start before provisioning or model calls"
assert_file_missing "$TEST_ROOT/live-state" \
  "blocked live lifecycle does not create v2 state"

"$tool" "$fixture_task" abandon --profile "$profile_id" \
  --attempt "$fixture_attempt" \
  --reason 'offline harness' \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" \
  --legacy-state-dir "$STATE_DIR" >/dev/null 2>&1
assert_rc 78 "$?" "offline harness blocks abandon as a live mutation"

"$tool" "$fixture_task" recover --profile "$profile_id" \
  --attempt "$fixture_attempt" \
  --reason 'offline harness' \
  --route feature \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" \
  --legacy-state-dir "$STATE_DIR" >/dev/null 2>&1
assert_rc 78 "$?" "offline harness blocks recover as a live mutation"
assert_file_missing "$TEST_ROOT/live-state" \
  "blocked admin lifecycle does not create v2 state"

assert_file_missing "$FACTORY_HOME/bin/factory-v2-canary" \
  "obsolete special launcher is removed"
assert_file_missing "$FACTORY_HOME/bin/factory-v2-canary-host.mjs" \
  "obsolete host wrapper is removed"

finish_tests
