#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
profile_dir="$FACTORY_PROFILES_DIR/fixture"
mkdir -p "$profile_dir"

printf '%s\n' \
  'PROFILE_NAME=fixture' \
  'PROFILE_ARCHIVE_ON_FINISH=1' \
  'run_pipeline() {' \
  '  set_st "$1" GATE_ACCEPT approved' \
  '  if [[ "${TAIL_RESULT:-done}" == pre_skipped ]]; then' \
  '    sed -i "s/^RETRO=.*/RETRO=skipped/" "$STATE_DIR/t${1}.pipeline"' \
  '    printf "%s\n" "RETRO_COMMENT=ретро неприменимо" >>"$STATE_DIR/t${1}.pipeline"' \
  '  fi' \
  '  return 0' \
  '}' \
  'run_stage() {' \
  '  local task=$1 stage=$2' \
  '  printf "%s\n" "$stage" >>"$TEST_ROOT/events-t${task}"' \
  '  if [[ "$stage" == RETRO && "${TAIL_RESULT:-done}" == fail ]]; then' \
  '    sed -i "s/^${stage}=.*/${stage}=failed/" "$STATE_DIR/t${task}.pipeline"' \
  '    return 1' \
  '  fi' \
  '  sed -i "s/^${stage}=.*/${stage}=done/" "$STATE_DIR/t${task}.pipeline"' \
  '}' \
  >"$profile_dir/profile.sh"
printf '%s\n' \
  'RUNNERS_SCHEMA=1' \
  'CONFIG_REVISION=1' \
  'RUNNERS_COVERAGE=required' \
  'PROJECT_RUNNER_PRIMARY=fixture' \
  >"$profile_dir/runners.env"

FACTORY_DAEMON=1 TAIL_RESULT=done \
  "$FACTORY_HOME/bin/factory" 71 start --profile fixture \
  >"$TEST_ROOT/success.out" 2>&1
assert_rc 0 "$?" "successful daemon completes the engine-owned tail"
assert_eq $'SHIP\nRETRO' "$(cat "$TEST_ROOT/events-t71")" \
  "SHIP and RETRO execute once and in order"
assert_file_missing "$STATE_DIR/t71.pipeline" \
  "active registry is removed only after the tail"
assert_file_exists "$STATE_DIR/archive/t71.pipeline" \
  "completed registry is archived"
assert_eq done "$(awk -F= '$1=="SHIP"{v=$2} END{print v}' "$STATE_DIR/archive/t71.pipeline")" \
  "archived state contains terminal SHIP"
assert_eq done "$(awk -F= '$1=="RETRO"{v=$2} END{print v}' "$STATE_DIR/archive/t71.pipeline")" \
  "archived state contains terminal RETRO"

FACTORY_DAEMON=1 TAIL_RESULT=fail \
  "$FACTORY_HOME/bin/factory" 72 start --profile fixture \
  >"$TEST_ROOT/failure.out" 2>&1
assert_rc 1 "$?" "failed tail keeps the attempt active"
assert_file_exists "$STATE_DIR/t72.pipeline" \
  "incomplete tail registry remains recoverable"
assert_file_missing "$STATE_DIR/archive/t72.pipeline" \
  "incomplete tail is never archived"
assert_eq 1 "$(awk -F= '$1=="STALLED_HUMAN"{v=$2} END{print v}' "$STATE_DIR/t72.pipeline")" \
  "incomplete tail explicitly stalls for a human"
if grep -q '] конвейер завершён$' "$STATE_DIR/logs/t72.stages.log"; then
  test_fail "incomplete tail never logs a false completion"
else
  test_ok "incomplete tail never logs a false completion"
fi

FACTORY_DAEMON=1 TAIL_RESULT=pre_skipped \
  "$FACTORY_HOME/bin/factory" 73 start --profile fixture \
  >"$TEST_ROOT/pre-skipped.out" 2>&1
assert_rc 0 "$?" "pre-skipped retro is a completed tail outcome"
assert_eq SHIP "$(cat "$TEST_ROOT/events-t73")" \
  "pre-skipped retro is not invoked again"
assert_file_missing "$STATE_DIR/t73.pipeline" \
  "pre-skipped tail leaves no active registry"
assert_file_exists "$STATE_DIR/archive/t73.pipeline" \
  "pre-skipped tail is archived"
assert_eq skipped "$(awk -F= '$1=="RETRO"{v=$2} END{print v}' "$STATE_DIR/archive/t73.pipeline")" \
  "archive preserves the skipped retro outcome"
assert_eq "ретро неприменимо" \
  "$(awk -F= '$1=="RETRO_COMMENT"{v=$2} END{print v}' "$STATE_DIR/archive/t73.pipeline")" \
  "archive preserves the skipped retro reason"

finish_tests
