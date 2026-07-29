#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/debug-settings.sh"

repeat=${TEST_REPEAT:-5}
for ((n=1; n<=repeat; n++)); do
  file="$TEST_ROOT/config/debug/race-$n.env"
  debug_settings_write "$file" 0 off 0 || {
    test_fail "debug settings race fixture initializes" "iteration=$n"
    finish_tests
    exit $?
  }
  (
    debug_settings_write "$file" 1 decisions 0
    printf '%s\n' "$?" >"$TEST_ROOT/debug-a-$n.rc"
  ) &
  a=$!
  (
    debug_settings_write "$file" 1 verbose 0
    printf '%s\n' "$?" >"$TEST_ROOT/debug-b-$n.rc"
  ) &
  b=$!
  wait "$a"
  wait "$b"
  pair="$(cat "$TEST_ROOT/debug-a-$n.rc") $(cat "$TEST_ROOT/debug-b-$n.rc")"
  case "$pair" in
    "0 72"|"72 0") ;;
    *)
      test_fail "debug settings CAS has one winner" "iteration=$n rc=[$pair]"
      finish_tests
      exit $?
      ;;
  esac
  debug_settings_validate "$file" || {
    test_fail "debug settings CAS leaves a whole document" "iteration=$n"
    finish_tests
    exit $?
  }
  [[ "$(debug_settings_get "$file" CONFIG_REVISION)" == 2 ]] || {
    test_fail "debug settings CAS increments once" "iteration=$n"
    finish_tests
    exit $?
  }
done
test_ok "debug settings writer invariant survives $repeat repetitions"
finish_tests
