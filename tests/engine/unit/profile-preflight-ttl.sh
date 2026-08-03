#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/profile-preflight.sh"

assert_eq 21600 "$(profile_preflight_ttl)" "host preflight remains valid for a normal work session"
assert_eq 3600 "$(profile_preflight_ttl 3600)" "explicit host preflight TTL is preserved"

FACTORY_HOST_PREFLIGHT_TTL=7200
assert_eq 7200 "$(profile_preflight_ttl)" "environment can configure host preflight TTL"

profile_preflight_ttl invalid >/dev/null 2>&1
assert_rc 2 "$?" "invalid host preflight TTL is rejected"

finish_tests
