#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/profile-preflight.sh" ]]; then
  test_fail "profile preflight module exists" "missing lib/profile-preflight.sh"
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/profile-preflight.sh"

export FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture"
config="$FACTORY_PROFILES_DIR/fixture/runners.env"
printf '%s\n' \
  RUNNERS_SCHEMA=1 CONFIG_REVISION=1 \
  PROJECT_RUNNER_PRIMARY=alpha PROJECT_RUNNER_FAILOVER=beta \
  MODEL_DEFAULT_ALPHA_FAMILY=fixture MODEL_DEFAULT_ALPHA_VERSION=latest \
  MODEL_DEFAULT_BETA_FAMILY=fixture MODEL_DEFAULT_BETA_VERSION=latest >"$config"

profile_runner_host_preflight fixture 100 60
assert_rc 0 "$?" "profile host preflight succeeds without a model call"
structural="$STATE_DIR/coverage/fixture/structural.env"
host="$STATE_DIR/coverage/fixture/host.env"
assert_file_exists "$structural" "profile preflight writes structural artifact"
assert_file_exists "$host" "profile preflight writes host artifact"
assert_eq 0 "$(coverage_artifact_get "$host" UNAVAILABLE)" "both configured providers are ready"
assert_eq "" "$(coverage_artifact_get "$host" UNAVAILABLE_RUNNERS)" \
  "ready preflight publishes an empty runner detail"
assert_file_missing "$TEST_ROOT/invocations" "preflight never invokes runner run method"

export FAKE_BETA_PROBE=missing
profile_runner_host_preflight fixture 200 60 >/dev/null 2>&1
assert_rc 1 "$?" "unavailable failover makes host preflight fail closed"
assert_eq 1 "$(coverage_artifact_get "$host" UNAVAILABLE)" \
  "unavailable configured provider is counted"
assert_eq beta "$(coverage_artifact_get "$host" UNAVAILABLE_RUNNERS)" \
  "host artifact names the unavailable configured provider"

mktemp() { return 1; }
profile_runner_host_preflight fixture 300 60 >/dev/null 2>&1
storage_rc=$?
unset -f mktemp
assert_rc 78 "$storage_rc" "coverage storage failure cannot report preflight success"

finish_tests
