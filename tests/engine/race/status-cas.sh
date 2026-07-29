#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/run-state.sh"

repeat=${TEST_REPEAT:-5}
for ((n=1; n<=repeat; n++)); do
  task=$((8000 + n))
  token="token-$n"
  run_state_begin "$task" BUILD "run-$n" 1 "$token"
  (
    run_state_apply_result "$task" BUILD "run-$n" 1 "$token" done
    printf '%s\n' "$?" >"$TEST_ROOT/a-$n.rc"
  ) &
  a=$!
  (
    run_state_apply_result "$task" BUILD "run-$n" 1 "$token" failed
    printf '%s\n' "$?" >"$TEST_ROOT/b-$n.rc"
  ) &
  b=$!
  wait "$a"; wait "$b"
  pair="$(cat "$TEST_ROOT/a-$n.rc") $(cat "$TEST_ROOT/b-$n.rc")"
  case "$pair" in
    "0 75"|"75 0") ;;
    *) test_fail "status CAS has one winner" "iteration=$n rc=[$pair]"; finish_tests; exit $? ;;
  esac
  case "$(pipeline_store_get "$task" BUILD)" in done|failed) ;; *)
    test_fail "status CAS stores one whole result" "iteration=$n"; finish_tests; exit $? ;;
  esac
done
test_ok "status CAS invariant survives $repeat repetitions"
finish_tests
