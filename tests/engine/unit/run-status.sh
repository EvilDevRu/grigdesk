#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

missing=0
for file in lib/pipeline-store.sh lib/run-state.sh lib/stage-result.sh lib/pipeline-control.sh; do
  if [[ ! -f "$FACTORY_HOME/$file" ]]; then
    test_fail "$file exists" "missing $file"
    missing=1
  fi
done
if (( missing )); then
  finish_tests
  exit $?
fi

source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/run-state.sh"

task=77
stage=CHECK
token_a="status-secret-a"
token_b="status-secret-b"
control_token="control-secret"

bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" --init "$stage" pending >/dev/null
factory_control_init "$control_token"
run_state_begin "$task" "$stage" run-a 1 "$token_a"
assert_rc 0 "$?" "active run begins"

run_state_apply_result "$task" "$stage" run-old 0 "$token_a" done ""
assert_rc 73 "$?" "old run id and epoch are stale"

run_state_apply_result "$task" "$stage" run-a 1 wrong-token done ""
assert_rc 74 "$?" "wrong capability is rejected"

run_state_apply_result "$task" "$stage" run-a 1 "$token_a" done "fixture done"
assert_rc 0 "$?" "active terminal result is accepted"
assert_eq done "$(pipeline_store_get "$task" "$stage")" "accepted result reaches pipeline"
assert_eq "fixture done" "$(pipeline_store_get "$task" "${stage}_COMMENT")" "comment is atomic with result"

run_state_apply_result "$task" "$stage" run-a 1 "$token_a" failed ""
assert_rc 75 "$?" "terminal result is accepted only once"
assert_eq done "$(pipeline_store_get "$task" "$stage")" "repeat cannot replace terminal result"

run_state_begin "$task" "$stage" run-b 2 "$token_b"
assert_rc 0 "$?" "replacement run gets new epoch"
run_state_begin "$task" "$stage" run-regressed 1 regressed-token >/dev/null 2>&1
assert_rc 73 "$?" "stage epoch cannot move backwards"
assert_eq run-b "$(_run_state_get "$(run_state_active_file "$task" "$stage")" RUN_ID)" \
  "rejected epoch leaves active run intact"

bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" "$stage" done >/dev/null 2>&1
assert_rc 73 "$?" "direct terminal pipeline-set is denied for protocol v2"
assert_eq running "$(pipeline_store_get "$task" "$stage")" "direct writer cannot finish active run"

exec 9<<<"$token_b"
FACTORY_STATUS_FD=9 bash "$FACTORY_HOME/lib/stage-result.sh" \
  --task "$task" --stage "$stage" --run-id run-b --epoch 2 skipped "fixture skip" >/dev/null
rc=$?
exec 9<&-
assert_rc 0 "$rc" "stage-result reads capability from inherited FD"
assert_eq skipped "$(pipeline_store_get "$task" "$stage")" "stage-result applies result"

run_state_begin "$task" "$stage" run-c 3 status-secret-c
exec 8<<<"$control_token"
FACTORY_CONTROL_FD=8 bash "$FACTORY_HOME/lib/pipeline-control.sh" \
  "$task" "$stage" failed "${stage}_COMMENT" "engine stop" >/dev/null
rc=$?
exec 8<&-
assert_rc 0 "$rc" "privileged control path accepts control capability"
assert_eq failed "$(pipeline_store_get "$task" "$stage")" "control path changes pipeline"

exec 9<<<"status-secret-c"
FACTORY_STATUS_FD=9 bash "$FACTORY_HOME/lib/stage-result.sh" \
  --task "$task" --stage "$stage" --run-id run-c --epoch 3 done >/dev/null 2>&1
rc=$?
exec 9<&-
assert_rc 75 "$rc" "privileged terminal control revokes active agent result"
assert_eq failed "$(pipeline_store_get "$task" "$stage")" "revoked agent cannot replace control result"

exec 8<<<"wrong-control"
FACTORY_CONTROL_FD=8 bash "$FACTORY_HOME/lib/pipeline-control.sh" \
  "$task" "$stage" done >/dev/null 2>&1
rc=$?
exec 8<&-
assert_rc 74 "$rc" "agent/status token cannot use privileged control path"

if rg -F 'status-secret-' "$STATE_DIR" "$FACTORY_CONFIG_ROOT" >/dev/null 2>&1; then
  test_fail "status capabilities do not leak to state/control files" "plaintext token found"
else
  test_ok "status capabilities do not leak to state/control files"
fi

finish_tests
