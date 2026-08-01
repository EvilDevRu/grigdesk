#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

tool="$FACTORY_HOME/bin/factory-v2"
routes="$TEST_ROOT/routes-v2"

"$NODE_BIN" "$FACTORY_HOME/../profiles/arsenkin/routes-v2/publish.mjs" \
  --publish \
  --base-dir "$routes" \
  --expected-catalog-hash null >/dev/null
assert_rc 0 "$?" "route source publishes for launcher contract"

for route in debug feature trivial; do
  output=$("$tool" check --profile arsenkin --route "$route" --routes-dir "$routes")
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
# Реестр читает не только кокпит, но и агенты: на прогоне t8165 PLAN увидел в нём
# TESTS=done от отменённой попытки и пошёл искать несуществующие тесты.
assert_contains "$source_text" 'set_st "$TASK" --init --stages "$(v2_registry_stage_keys "$new_catalog")"' \
  "recovery re-inits the registry from the newly pinned catalog"
assert_contains "$source_text" 'v2_quarantine_state_artifacts "$EXPECTED_ATTEMPT" || return' \
  "recovery takes the predecessor stage artifacts off the disk"

ticket="$TEST_ROOT/ticket.json"
cat >"$ticket" <<'JSON'
{
  "schema": 1,
  "taskId": "8166",
  "title": "offline boundary",
  "description": "must not launch",
  "acceptanceCriteria": ["no live mutation"],
  "sourceUrl": "https://portal.example.test/tasks/8166"
}
JSON

"$tool" 8166 start --profile arsenkin \
  --route feature \
  --ticket-json "$ticket" \
  --routes-dir "$routes" \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" \
  --legacy-state-dir "$STATE_DIR" >/dev/null 2>&1
assert_rc 78 "$?" "offline harness blocks start before provisioning or model calls"
assert_file_missing "$TEST_ROOT/live-state" \
  "blocked live lifecycle does not create v2 state"

"$tool" 8166 abandon --profile arsenkin \
  --attempt a_0123456789abcdef0123456789abcdef \
  --reason 'offline harness' \
  --state-dir "$TEST_ROOT/live-state" \
  --control-dir "$TEST_ROOT/live-control" \
  --legacy-state-dir "$STATE_DIR" >/dev/null 2>&1
assert_rc 78 "$?" "offline harness blocks abandon as a live mutation"

"$tool" 8166 recover --profile arsenkin \
  --attempt a_0123456789abcdef0123456789abcdef \
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
