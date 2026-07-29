#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/run-state.sh"

progress="$FACTORY_HOME/lib/stage-progress.sh"
if [[ ! -x "$progress" ]]; then
  test_fail "run-scoped progress command exists" "missing lib/stage-progress.sh"
  finish_tests
  exit $?
fi

task=58
stage=PLAN
token=progress-secret
factory_control_init control-secret
run_state_begin "$task" "$stage" run-a 1 "$token"
token_file="$TEST_ROOT/token"
printf '%s\n' "$token" >"$token_file"
exec 7<"$token_file"

FACTORY_STATUS_FD=7 "$progress" --task "$task" --stage "$stage" \
  --run-id run-a --epoch 1 PLANS done ROUTE feature
assert_rc 0 "$?" "current run can publish non-terminal progress"
assert_eq done "$(pipeline_store_get "$task" PLANS)" "progress node reaches pipeline"
assert_eq feature "$(pipeline_store_get "$task" ROUTE)" "route metadata reaches pipeline"

FACTORY_STATUS_FD=7 "$progress" --task "$task" --stage "$stage" \
  --run-id run-a --epoch 1 PLAN done >/dev/null 2>&1
assert_rc 2 "$?" "progress command cannot bypass terminal result API"

FACTORY_STATUS_FD=7 "$progress" --task "$task" --stage "$stage" \
  --run-id run-a --epoch 1 RUN_PROTOCOL 1 >/dev/null 2>&1
assert_rc 2 "$?" "progress command cannot mutate protocol controls"

FACTORY_STATUS_FD=7 "$progress" --task "$task" --stage "$stage" \
  --run-id run-a --epoch 1 RUNNER_OVERRIDE_PROJECT codex >/dev/null 2>&1
assert_rc 2 "$?" "progress command cannot mutate runner overrides"

FACTORY_STATUS_FD=7 "$progress" --task "$task" --stage "$stage" \
  --run-id run-a --epoch 1 ROUTE_BY human >/dev/null 2>&1
assert_rc 2 "$?" "agent cannot impersonate a human route decision"

FACTORY_STATUS_FD=7 "$progress" --task "$task" --stage "$stage" \
  --run-id run-a --epoch 1 SIZE XL >/dev/null 2>&1
assert_rc 2 "$?" "progress values are schema-validated"

FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" --task "$task" --stage "$stage" \
  --run-id run-a --epoch 1 done
assert_rc 0 "$?" "status capability remains reusable after progress update"

FACTORY_STATUS_FD=7 "$progress" --task "$task" --stage "$stage" \
  --run-id run-a --epoch 1 VALIDATE done >/dev/null 2>&1
assert_rc 75 "$?" "committed run cannot publish late progress"
exec 7<&-

finish_tests
