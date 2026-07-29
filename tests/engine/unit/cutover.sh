#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/profile-config.sh"
source "$FACTORY_HOME/lib/routing.sh"

export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/missing"
printf 'PROFILE_NAME=missing\n' >"$FACTORY_PROFILES_DIR/missing/profile.sh"

"$FACTORY_HOME/bin/factory" profile missing runner show >"$TEST_ROOT/missing.out" 2>&1
assert_rc 78 "$?" "profile without canonical runner config fails closed"
assert_contains "$(cat "$TEST_ROOT/missing.out")" "canonical" \
  "missing config error names the required source of truth"

declare -F profile_config_migrate >/dev/null
assert_rc 1 "$?" "runtime has no implicit profile migration function"

grep -qE 'timeout[^[:cntrl:]]*claude -p' "$FACTORY_HOME/lib/core.sh"
assert_rc 1 "$?" "core has no direct Claude-only execution path"

grep -Fq 't${t}.${key}.status' "$FACTORY_HOME/lib/core.sh"
assert_rc 1 "$?" "core no longer reads fixed status markers"

grep -Fq 'Bash($FACTORY_HOME/lib/pipeline-set.sh' "$FACTORY_HOME/lib/core.sh"
assert_rc 1 "$?" "agent settings expose no generic pipeline writer"

finish_tests
