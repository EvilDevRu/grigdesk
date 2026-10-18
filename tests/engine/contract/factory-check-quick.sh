#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

user_state="$TEST_ROOT/user-state"
mkdir -p "$user_state"
printf 'do-not-read-or-write\n' >"$user_state/canary"
report="$TEST_ROOT/quick-state"

FACTORY_STATE="$user_state" FACTORY_CHECK_STATE_REPORT="$report" \
  FACTORY_CHECK_ONLY_ISOLATION=1 "$FACTORY_HOME/bin/factory-check" grigdesk --quick \
  >"$TEST_ROOT/check.out" 2>&1
assert_rc 0 "$?" "quick check can initialize without profile/model work"
assert_file_exists "$report" "quick check reports isolated state in test mode"
effective=$(cat "$report" 2>/dev/null)
case "$effective" in
  /tmp/factory-check.*/state) test_ok "quick check replaces caller state with a temporary root" ;;
  *) test_fail "quick check replaces caller state with a temporary root" "$effective" ;;
esac
assert_eq do-not-read-or-write "$(cat "$user_state/canary")" "caller state remains untouched"
count=$(find "$user_state" -mindepth 1 -maxdepth 1 | wc -l)
assert_eq 1 "$count" "quick check creates nothing in caller state"

finish_tests
