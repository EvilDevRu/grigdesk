#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

runner="$FACTORY_HOME/lib/runners/deepseek.sh"
wrapper="$FACTORY_HOME/../server/scripts/deepseekRunner.mts"
if [[ ! -f "$runner" || ! -f "$wrapper" ]]; then
  test_fail "DeepSeek stop contract dependencies exist" "missing runner or wrapper"
  finish_tests
  exit $?
fi

task=145
stage=CHECK
run_id=run-deepseek-timeout
run_dir="$STATE_DIR/logs/runs/t${task}/${stage}/${run_id}"
pipeline_store_route_init "$task" "$stage"
factory_control_init control-secret
run_state_begin "$task" "$stage" "$run_id" 1 stop-token

scenario="$TEST_ROOT/deepseek-stop.json"
fake_log="$TEST_ROOT/deepseek-stop-acp.jsonl"
printf '%s\n' '{
  "configOptions":[
    {"id":"model","options":[{"value":"[\"deepseek-official\",\"deepseek-v4-flash\"]"}]},
    {"id":"reasoning_effort","options":[{"value":"high"}]}
  ],
  "waitForCancel":true
}' >"$scenario"

marker="deepseek-stubborn-${RANDOM}-${RANDOM}"
fake_bin="$TEST_ROOT/dsh-stop-fake"
printf '#!/usr/bin/env bash\nexec "%s" "%s" --scenario "%s" --log "%s" --stubborn-marker "%s" "$@"\n' \
  "$NODE_BIN" "$FACTORY_HOME/../tests/fixtures/deepseek-harness/fakeBinary.mts" \
  "$scenario" "$fake_log" "$marker" >"$fake_bin"
chmod +x "$fake_bin"

export GRIGDESK_DEEPSEEK_BIN="$fake_bin"
export DEEPSEEK_API_KEY=synthetic-factory-key
export FACTORY_FORBID_LIVE=0
export FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write
runner_registry_reset
runner_registry_add deepseek "$runner"

runner_launch deepseek "$task" "wait until cancelled" "$stage" \
  '["deepseek-official","deepseek-v4-flash"]' high 1 \
  "$run_dir" "$run_id" 1 stop-token >/dev/null 2>&1
assert_rc 124 "$?" "timeout remains distinguishable after graceful ACP cancellation"

alive=1
for _poll in {1..200}; do
  if ! pgrep -f "^${marker}( |$)" >/dev/null 2>&1; then
    alive=0
    break
  fi
  sleep 0.02
done
if [[ "$alive" == 0 ]]; then
  test_ok "stubborn tool grandchild does not survive timeout quiescence"
else
  test_fail "stubborn tool grandchild does not survive timeout quiescence" "$marker is alive"
  pkill -KILL -f "^${marker}( |$)" 2>/dev/null || true
fi
assert_contains "$(cat "$fake_log")" '"method":"session/prompt"' \
  "timeout interrupts an active ACP prompt"
if grep -Fq '"event":"result"' "$run_dir/events.jsonl" 2>/dev/null; then
  test_fail "timed-out prompt cannot be retained as a successful result" \
    "result event found after timeout"
else
  test_ok "timed-out prompt cannot be retained as a successful result"
fi

finish_tests
