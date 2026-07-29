#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

migrator="$FACTORY_HOME/bin/factory-migrate-v2"
if [[ ! -x "$migrator" ]]; then
  test_fail "protocol v2 migrator exists" "missing executable bin/factory-migrate-v2"
  finish_tests
  exit $?
fi

export FACTORY_STATE="$TEST_ROOT/state"
export STATE_DIR="$FACTORY_STATE"
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$STATE_DIR/archive" "$FACTORY_PROFILES_DIR/fixture"
printf 'PROFILE_NAME=fixture\n' >"$FACTORY_PROFILES_DIR/fixture/profile.sh"
printf '%s\n' RUNNERS_SCHEMA=1 CONFIG_REVISION=1 RUNNERS_COVERAGE=required \
  PROJECT_RUNNER_PRIMARY=alpha PROJECT_RUNNER_FAILOVER=beta \
  >"$FACTORY_PROFILES_DIR/fixture/runners.env"

printf 'PROFILE=fixture\nWF_STATUS=running\nBUILD=running\n' >"$STATE_DIR/t1.pipeline"
printf 'PROFILE=fixture\nWF_STATUS=done\n' >"$STATE_DIR/archive/t2.pipeline"
printf 'ghost\n' >"$STATE_DIR/tt3.pipeline"
printf 'done\n' >"$STATE_DIR/t1.BUILD.status"

"$migrator" >"$TEST_ROOT/migrate.out"
assert_rc 0 "$?" "stopped task state migrates atomically"
assert_eq 2 "$(awk -F= '$1=="RUN_PROTOCOL"{print $2}' "$STATE_DIR/t1.pipeline")" \
  "active state is protocol v2"
assert_eq 2 "$(awk -F= '$1=="RUN_PROTOCOL"{print $2}' "$STATE_DIR/archive/t2.pipeline")" \
  "archived state is protocol v2"
assert_file_missing "$STATE_DIR/t1.BUILD.status" "fixed marker leaves live state"
assert_file_missing "$STATE_DIR/tt3.pipeline" "malformed ghost leaves live state"
backup=$(find "$STATE_DIR/migrations" -mindepth 1 -maxdepth 1 -type d | head -1)
assert_file_exists "$backup/active/t1.pipeline" "migration keeps recoverable active backup"
assert_file_exists "$backup/archive/t2.pipeline" "migration keeps recoverable archive backup"
assert_file_exists "$backup/markers/t1.BUILD.status" "fixed marker is recoverable"
assert_file_exists "$backup/debris/tt3.pipeline" "malformed ghost is recoverable"

"$migrator" >"$TEST_ROOT/migrate-again.out"
assert_rc 0 "$?" "migration is idempotent"
assert_contains "$(cat "$TEST_ROOT/migrate-again.out")" "изменений нет" \
  "idempotent run reports no work"

printf 'PROFILE=fixture\nWF_STATUS=running\n' >"$STATE_DIR/t4.pipeline"
sleep 30 &
live_pid=$!
printf 'ORCH_PID=%s\n' "$live_pid" >>"$STATE_DIR/t4.pipeline"
"$migrator" >"$TEST_ROOT/live.out" 2>&1
live_rc=$?
kill "$live_pid" 2>/dev/null || true
wait "$live_pid" 2>/dev/null || true
assert_rc 76 "$live_rc" "migration refuses a live orchestrator"
assert_eq "" "$(awk -F= '$1=="RUN_PROTOCOL"{print $2}' "$STATE_DIR/t4.pipeline")" \
  "refused live state remains untouched"

finish_tests
