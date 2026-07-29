#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

task=43
stage=CHECK
run_id=run-sandboxed
token=sandboxed-secret
run_dir="$STATE_DIR/logs/runs/t${task}/${stage}/${run_id}"

bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" --init "$stage" pending >/dev/null
factory_control_init control-secret
run_state_begin "$task" "$stage" "$run_id" 1 "$token"

runner_registry_reset
runner_registry_add sandboxed "$FACTORY_TESTS_HOME/fakes/runners/sandboxed.sh"
runner_launch sandboxed "$task" "finish the stage" "$stage" sandboxed-model high 5 \
  "$run_dir" "$run_id" 1 "$token"
rc=$?

assert_rc 0 "$rc" "sandboxed runner completes without inherited status FD"
assert_eq 0 "$(find "$run_dir/control-requests" -type f 2>/dev/null | wc -l)" \
  "invalid deferred progress never enters the request queue"
assert_file_exists "$run_dir/progress-visible" "deferred progress is applied while the runner is alive"
assert_eq feature "$(pipeline_store_get "$task" ROUTE)" "deferred progress reaches the registry"
assert_eq done "$(pipeline_store_get "$task" "$stage")" "deferred terminal result reaches the registry"
assert_eq "sandbox completed" "$(pipeline_store_get "$task" "${stage}_COMMENT")" \
  "deferred terminal comment is preserved"
if rg -F "$token" "$run_dir" >/dev/null 2>&1; then
  test_fail "deferred channel keeps capability outside sandbox artifacts" "token leaked into RUN_DIR"
else
  test_ok "deferred channel keeps capability outside sandbox artifacts"
fi

finish_tests
