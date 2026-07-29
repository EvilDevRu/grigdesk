#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

for file in lib/debug-settings.sh lib/debug-log.sh; do
  if [[ ! -f "$FACTORY_HOME/$file" ]]; then
    test_fail "debug logging modules exist" "missing $file"
    finish_tests
    exit $?
  fi
done

source "$FACTORY_HOME/lib/debug-settings.sh"
source "$FACTORY_HOME/lib/debug-log.sh"
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

export FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"
runner_registry_reset
runner_registry_add fake "$FACTORY_RUNNERS_DIR/fake.sh"
printf 'PROFILE=fixture\n' >"$STATE_DIR/t81.pipeline"

export FACTORY_RUN_PROFILE=fixture
export FACTORY_DEBUG_ROUTE_SOURCE=project
export FACTORY_DEBUG_PRIMARY=fake
export FACTORY_DEBUG_FAILOVER=
export FACTORY_DEBUG_FAMILY=fixture
export FACTORY_DEBUG_CATALOG_REVISION=fixture-1
export FACTORY_DEBUG_PLAN_LEVEL=native

off_dir="$STATE_DIR/logs/runs/t81/BUILD/off-run"
runner_launch fake 81 "prompt-canary-secret" BUILD fake-model high 5 \
  "$off_dir" off-run 1 status-secret-off
off_rc=$?
assert_rc 0 "$off_rc" "runner result is successful with debug off"
assert_file_missing "$off_dir/debug.trace.jsonl" "default off creates no debug trace"
assert_contains "$(cat "$off_dir/meta.env")" "DEBUG_LEVEL=off" \
  "mandatory run audit records effective off level"

global_file=$(debug_settings_global_file)
debug_settings_write "$global_file" 0 decisions 0
assert_rc 0 "$?" "decisions logging can be enabled"

on_dir="$STATE_DIR/logs/runs/t81/BUILD/on-run"
runner_launch fake 81 "prompt-canary-secret" BUILD fake-model high 5 \
  "$on_dir" on-run 2 status-secret-on
on_rc=$?
assert_rc "$off_rc" "$on_rc" "debug level does not change runner result"
assert_file_exists "$on_dir/debug.trace.jsonl" "enabled decisions level creates trace"
trace=$(cat "$on_dir/debug.trace.jsonl")
assert_contains "$trace" '"event":"route_resolved"' "trace explains routing/model decision"
assert_contains "$trace" '"event":"runner_result"' "trace records normalized result"
if [[ "$trace" == *"prompt-canary-secret"* || "$trace" == *"status-secret-on"* ]]; then
  test_fail "trace excludes prompt and status capability" "sensitive input leaked"
else
  test_ok "trace excludes prompt and status capability"
fi

revision=$(debug_settings_get "$global_file" CONFIG_REVISION)
debug_settings_write "$global_file" "$revision" errors 0
error_dir="$STATE_DIR/logs/runs/t81/CHECK/error-run"
FAKE_RUNNER_RC=7 runner_launch fake 81 "prompt-canary-secret" CHECK fake-model high 5 \
  "$error_dir" error-run 1 status-secret-error
error_rc=$?
assert_rc 7 "$error_rc" "errors level preserves failing runner rc"
error_trace=$(cat "$error_dir/debug.trace.jsonl")
assert_contains "$error_trace" '"event":"runner_error"' \
  "errors level records normalized runner failure"
if [[ "$error_trace" == *'"event":"route_resolved"'* ]]; then
  test_fail "errors level omits ordinary decision events" "decision event was too verbose"
else
  test_ok "errors level omits ordinary decision events"
fi

revision=$(debug_settings_get "$global_file" CONFIG_REVISION)
debug_settings_write "$global_file" "$revision" decisions 0
before_cross_stage=$(sha256sum "$on_dir/debug.trace.jsonl" | awk '{print $1}')
debug_log_event_for 81 REVIEW decisions dispatch_complete runner fake result unavailable \
  reason unavailable_preflight
assert_rc 0 "$?" "event for a stage without a run is ignored safely"
after_cross_stage=$(sha256sum "$on_dir/debug.trace.jsonl" | awk '{print $1}')
assert_eq "$before_cross_stage" "$after_cross_stage" \
  "preflight-only stage cannot contaminate previous run trace"

dynamic_dir="$STATE_DIR/logs/runs/t81/REVIEW/dynamic-run"
mkdir -p "$dynamic_dir"
printf 'SCHEMA=1\n' >"$dynamic_dir/meta.env"
debug_log_init fixture 81 REVIEW "$dynamic_dir" dynamic-run 1
debug_log_event decisions route_resolved runner fake model fake-model reason primary
assert_rc 0 "$?" "active debug session accepts typed decision event"

revision=$(debug_settings_get "$global_file" CONFIG_REVISION)
debug_settings_write "$global_file" "$revision" off 0
debug_log_event decisions after_disable runner fake
assert_rc 0 "$?" "runtime disable is non-fatal"
dynamic_trace=$(cat "$dynamic_dir/debug.trace.jsonl")
assert_contains "$dynamic_trace" '"event":"debug_disabled"' \
  "runtime off closes active trace explicitly"
if [[ "$dynamic_trace" == *'"event":"after_disable"'* ]]; then
  test_fail "runtime off stops detailed events" "event written after disable"
else
  test_ok "runtime off stops detailed events"
fi

revision=$(debug_settings_get "$global_file" CONFIG_REVISION)
debug_settings_write "$global_file" "$revision" verbose 0
debug_log_event verbose process_observed runner fake pid 123 elapsed_ms 5
assert_rc 0 "$?" "runtime enable resumes from current event"
dynamic_trace=$(cat "$dynamic_dir/debug.trace.jsonl")
assert_contains "$dynamic_trace" '"event":"debug_enabled"' \
  "mid-run enable is marked"
assert_contains "$dynamic_trace" '"partial":"1"' \
  "mid-run trace never claims missing history"
assert_contains "$dynamic_trace" '"event":"process_observed"' \
  "verbose event is recorded after enable"

debug_log_event verbose unsafe credential status-secret-on >/dev/null 2>&1
assert_rc 2 "$?" "logger rejects fields outside typed allowlist"
if rg -F 'status-secret-on' "$dynamic_dir/debug.trace.jsonl" >/dev/null 2>&1; then
  test_fail "rejected fields never reach trace" "secret leaked through unknown field"
else
  test_ok "rejected fields never reach trace"
fi

export FACTORY_DEBUG_MAX_BYTES=320
limited_dir="$STATE_DIR/logs/runs/t81/TESTS/limited-run"
mkdir -p "$limited_dir"
printf 'SCHEMA=1\n' >"$limited_dir/meta.env"
debug_log_init fixture 81 TESTS "$limited_dir" limited-run 1
for n in {1..20}; do
  debug_log_event verbose process_observed runner fake attempt "$n" elapsed_ms "$n"
done
assert_contains "$(cat "$limited_dir/meta.env")" "DEBUG_DROPPED=size_limit" \
  "size limit is visible in mandatory audit"
limited_size=$(stat -c %s "$limited_dir/debug.trace.jsonl")
if (( limited_size <= FACTORY_DEBUG_MAX_BYTES + 160 )); then
  test_ok "trace growth is bounded after size limit"
else
  test_fail "trace growth is bounded after size limit" \
    "size=$limited_size max=$FACTORY_DEBUG_MAX_BYTES"
fi
unset FACTORY_DEBUG_MAX_BYTES

old_dir="$STATE_DIR/logs/runs/t81/PLAN/old-run"
mkdir -p "$old_dir"
printf '{}\n' >"$old_dir/debug.trace.jsonl"
touch -d '@10' "$old_dir/debug.trace.jsonl"
debug_log_cleanup "$STATE_DIR/logs/runs" 1000 100
assert_file_missing "$old_dir/debug.trace.jsonl" "expired debug trace is removed by bounded cleanup"
assert_file_exists "$on_dir/debug.trace.jsonl" "cleanup preserves fresh debug trace"

finish_tests
