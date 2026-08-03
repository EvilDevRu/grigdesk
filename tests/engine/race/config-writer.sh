#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/profile-config.sh"

repeat=${TEST_REPEAT:-5}
for ((n=1; n<=repeat; n++)); do
  file="$TEST_ROOT/profile-$n.runners.env"
  profile_config_create "$file" alpha beta
  (
    profile_config_write "$file" 1 PROJECT_RUNNER_PRIMARY first
    printf '%s\n' "$?" >"$TEST_ROOT/a-$n.rc"
  ) &
  a=$!
  (
    profile_config_write "$file" 1 PROJECT_RUNNER_FAILOVER second
    printf '%s\n' "$?" >"$TEST_ROOT/b-$n.rc"
  ) &
  b=$!
  wait "$a"; wait "$b"
  pair="$(cat "$TEST_ROOT/a-$n.rc") $(cat "$TEST_ROOT/b-$n.rc")"
  case "$pair" in
    "0 72"|"72 0") ;;
    *) test_fail "config CAS has one winner" "iteration=$n rc=[$pair]"; finish_tests; exit $? ;;
  esac
  profile_config_validate "$file" || {
    test_fail "config CAS leaves a whole document" "iteration=$n"
    finish_tests
    exit $?
  }
  [[ "$(profile_config_get "$file" CONFIG_REVISION)" == 2 ]] || {
    test_fail "config CAS increments once" "iteration=$n"
    finish_tests
    exit $?
  }
done
test_ok "config writer invariant survives $repeat repetitions"
finish_tests
