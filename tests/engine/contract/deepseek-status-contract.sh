#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

runner="$FACTORY_HOME/lib/runners/deepseek.sh"
wrapper="$FACTORY_HOME/../server/scripts/deepseekRunner.mts"
status_mcp="$FACTORY_HOME/../server/scripts/deepseekStatusMcp.mts"
for required in "$runner" "$wrapper" "$status_mcp"; do
  if [[ ! -f "$required" ]]; then
    test_fail "DeepSeek status contract dependency exists" "missing $required"
    finish_tests
    exit $?
  fi
done

task=143
stage=CHECK
run_id=run-deepseek-status
token=deepseek-status-secret
run_dir="$STATE_DIR/logs/runs/t${task}/${stage}/${run_id}"
pipeline_store_route_init "$task" "$stage"
assert_rc 0 "$?" "DeepSeek status fixture initializes the route registry"
factory_control_init control-secret
run_state_begin "$task" "$stage" "$run_id" 1 "$token"

scenario="$TEST_ROOT/deepseek-status-scenario.json"
fake_log="$TEST_ROOT/deepseek-status-acp.jsonl"
side_effect="$TEST_ROOT/unexpected-permission-side-effect"
printf '%s\n' "{
  \"redactMcpEnv\": true,
  \"configOptions\": [
    {\"id\":\"model\",\"category\":\"model\",\"currentValue\":\"[\\\"deepseek-official\\\",\\\"deepseek-v4-flash\\\"]\",\"options\":[{\"value\":\"[\\\"deepseek-official\\\",\\\"deepseek-v4-flash\\\"]\"}]},
    {\"id\":\"reasoning_effort\",\"category\":\"thought_level\",\"currentValue\":\"high\",\"options\":[{\"value\":\"high\"}]}
  ],
  \"updates\": [
    {\"sessionUpdate\":\"tool_call\",\"toolCallId\":\"unexpected\",\"title\":\"bash\",\"rawInput\":{\"command\":\"touch forbidden\"}},
    {\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"готово\"}}
  ],
  \"permission\": {\"toolCallId\":\"unexpected\"},
  \"sideEffectOnAllow\": \"$side_effect\",
  \"mcpCalls\": [
    {\"server\":\"factory-status\",\"tool\":\"stage_result\",\"arguments\":{\"task\":999,\"result\":\"done\",\"comment\":\"identity injection\"}},
    {\"server\":\"factory-status\",\"tool\":\"stage_progress\",\"arguments\":{\"updates\":[{\"key\":\"PLANS\",\"value\":\"done\"}]},\"delayAfterMs\":700},
    {\"server\":\"factory-status\",\"tool\":\"stage_result\",\"arguments\":{\"result\":\"done\",\"comment\":\"deepseek completed\"}},
    {\"server\":\"factory-status\",\"tool\":\"stage_result\",\"arguments\":{\"result\":\"done\",\"comment\":\"duplicate must be stale\"}}
  ]
}" >"$scenario"

fake_bin="$TEST_ROOT/dsh-factory-fake"
printf '#!/usr/bin/env bash\nexec "%s" "%s" --scenario "%s" --log "%s" "$@"\n' \
  "$NODE_BIN" "$FACTORY_HOME/../tests/fixtures/deepseek-harness/fakeBinary.mts" \
  "$scenario" "$fake_log" >"$fake_bin"
chmod +x "$fake_bin"

export GRIGDESK_DEEPSEEK_BIN="$fake_bin"
export DEEPSEEK_API_KEY=synthetic-factory-key
export FACTORY_FORBID_LIVE=0
export FACTORY_ROUTE_FILESYSTEM_POLICY=state-only
runner_registry_reset
runner_registry_add deepseek "$runner"

runner_launch deepseek "$task" "finish only through the status tool" "$stage" \
  '["deepseek-official","deepseek-v4-flash"]' high 10 \
  "$run_dir" "$run_id" 1 "$token" >"$TEST_ROOT/launch.out" 2>"$TEST_ROOT/launch.err" &
launch_pid=$!
progress_visible=0
for _poll in {1..200}; do
  if [[ "$(pipeline_store_get "$task" PLANS 2>/dev/null)" == done ]]; then
    progress_visible=1
    break
  fi
  sleep 0.02
done
assert_eq 1 "$progress_visible" "MCP progress becomes visible before the turn ends"
kill -0 "$launch_pid" 2>/dev/null
assert_rc 0 "$?" "runner is still alive during the progress delay"
wait "$launch_pid"
assert_rc 0 "$?" "DeepSeek runner completes through fake ACP"

assert_eq done "$(pipeline_store_get "$task" "$stage")" \
  "stage_result closes the exact active stage"
assert_eq 'deepseek completed' "$(pipeline_store_get "$task" "${stage}_COMMENT")" \
  "first terminal result wins over a duplicate"
assert_eq 0 "$(find "$run_dir/control-requests" -type f 2>/dev/null | wc -l)" \
  "accepted and stale duplicate requests are consumed"
assert_file_missing "$side_effect" "unexpected Factory permission is reject-once without side effect"
assert_contains "$(cat "$fake_log")" '"optionId":"reject-once"' \
  "ACP receives reject-once for an unexpected Factory permission"
assert_contains "$(cat "$fake_log")" '"isError":true' \
  "status MCP rejects caller-supplied run identity instead of forwarding it"
assert_contains "$(cat "$run_dir/events.jsonl")" '"event":"permission"' \
  "permission rejection is visible in the retained event journal"

for name in FACTORY_RUN_TASK FACTORY_RUN_STAGE FACTORY_RUN_ID FACTORY_RUN_EPOCH \
  FACTORY_STATUS_MODE FACTORY_STATUS_REQUEST_DIR; do
  assert_contains "$(cat "$fake_log")" "\"name\":\"$name\",\"value\":\"<redacted>\"" \
    "$name reaches only the declared MCP environment"
done
if rg -F "$token" "$run_dir" >/dev/null 2>&1; then
  test_fail "status capability stays outside DeepSeek artifacts" "token leaked into RUN_DIR"
else
  test_ok "status capability stays outside DeepSeek artifacts"
fi
if rg -F 'synthetic-factory-key' "$run_dir" >/dev/null 2>&1; then
  test_fail "DeepSeek API key stays outside Factory artifacts" "key leaked into RUN_DIR"
else
  test_ok "DeepSeek API key stays outside Factory artifacts"
fi
if rg -F 'DEEPSEEK_API_KEY' "$fake_log" >/dev/null 2>&1; then
  test_fail "status MCP does not inherit provider credentials" "key name reached MCP env"
else
  test_ok "status MCP does not inherit provider credentials"
fi

# A friendly final answer and rc=0 are not a terminal status protocol.
task_text=144
run_text=run-deepseek-text-only
dir_text="$STATE_DIR/logs/runs/t${task_text}/${stage}/${run_text}"
pipeline_store_route_init "$task_text" "$stage"
run_state_begin "$task_text" "$stage" "$run_text" 1 text-token
scenario_text="$TEST_ROOT/deepseek-text-scenario.json"
log_text="$TEST_ROOT/deepseek-text-acp.jsonl"
# Keep this second fixture deliberately small and valid instead of mutating the first.
printf '%s\n' '{"configOptions":[{"id":"model","options":[{"value":"[\"deepseek-official\",\"deepseek-v4-flash\"]"}]},{"id":"reasoning_effort","options":[{"value":"high"}]}],"updates":[{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"готово"}}]}' >"$scenario_text"
printf '#!/usr/bin/env bash\nexec "%s" "%s" --scenario "%s" --log "%s" "$@"\n' \
  "$NODE_BIN" "$FACTORY_HOME/../tests/fixtures/deepseek-harness/fakeBinary.mts" \
  "$scenario_text" "$log_text" >"$fake_bin"
chmod +x "$fake_bin"
runner_launch deepseek "$task_text" "say ready" "$stage" \
  '["deepseek-official","deepseek-v4-flash"]' high 10 \
  "$dir_text" "$run_text" 1 text-token >/dev/null 2>&1
assert_rc 76 "$?" "text-only turn is promoted to a missing-status protocol error"
if [[ "$(pipeline_store_get "$task_text" "$stage")" == done ]]; then
  test_fail "plain text cannot close a Factory stage" "stage became done without stage_result"
else
  test_ok "plain text cannot close a Factory stage"
fi

finish_tests
