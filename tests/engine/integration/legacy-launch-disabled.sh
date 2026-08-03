#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
profile_id=legacy-fixture
profile_dir="$FACTORY_PROFILES_DIR/$profile_id"
routes_dir="$TEST_ROOT/routes"
state_dir="$TEST_ROOT/legacy-state"
control_dir="$TEST_ROOT/legacy-control"
legacy_marker="$TEST_ROOT/legacy-hook-called"
ticket="$TEST_ROOT/ticket.json"
attempt=a_71717171717171717171717171717171
mkdir -p "$profile_dir" "$routes_dir"

cat >"$profile_dir/profile.sh" <<'PROFILE'
PROFILE_NAME=legacy-fixture
run_pipeline() { touch "${LEGACY_MARKER:?}"; }
run_stage() { touch "${LEGACY_MARKER:?}"; }
profile_sandbox_up() { touch "${LEGACY_MARKER:?}"; }
PROFILE
printf '%s\n' \
  RUNNERS_SCHEMA=1 \
  CONFIG_REVISION=1 \
  RUNNERS_COVERAGE=required \
  PROJECT_RUNNER_PRIMARY=fixture \
  >"$profile_dir/runners.env"
printf '%s\n' '{"capabilities":[]}' >"$profile_dir/graph.json"
cat >"$ticket" <<JSON
{
  "schema": 1,
  "taskId": "71",
  "title": "legacy launcher must stay disabled",
  "description": "a profile with only legacy hooks cannot execute",
  "acceptanceCriteria": ["fail closed"],
  "sourceUrl": "https://portal.example.test/fixtures/71"
}
JSON

start_error=$(FACTORY_FORBID_LIVE=0 LEGACY_MARKER="$legacy_marker" \
  "$FACTORY_HOME/bin/factory" 71 start --profile "$profile_id" \
    --route feature \
    --ticket-json "$ticket" \
    --routes-dir "$routes_dir" \
    --state-dir "$state_dir" \
    --control-dir "$control_dir" 2>&1)
assert_rc 78 "$?" "a profile without route-v2 capability cannot start"
assert_contains "$start_error" 'не заявляет capability "route-v2"' \
  "start reports the fail-closed capability boundary"
assert_file_missing "$legacy_marker" \
  "start never invokes legacy pipeline, stage or sandbox hooks"
assert_file_missing "$state_dir" \
  "rejected legacy start creates no provider-writable state"
assert_file_missing "$control_dir" \
  "rejected legacy start creates no trusted attempt state"

resume_error=$(FACTORY_FORBID_LIVE=0 LEGACY_MARKER="$legacy_marker" \
  "$FACTORY_HOME/bin/factory" 71 resume --profile "$profile_id" \
    --attempt "$attempt" \
    --routes-dir "$routes_dir" \
    --state-dir "$state_dir" \
    --control-dir "$control_dir" 2>&1)
assert_rc 78 "$?" "a profile without route-v2 capability cannot resume"
assert_contains "$resume_error" 'не заявляет capability "route-v2"' \
  "resume reports the same fail-closed capability boundary"
assert_file_missing "$legacy_marker" \
  "resume never invokes legacy pipeline, stage or sandbox hooks"
assert_file_missing "$state_dir" \
  "rejected legacy resume creates no provider-writable state"
assert_file_missing "$control_dir" \
  "rejected legacy resume creates no trusted attempt state"

finish_tests
