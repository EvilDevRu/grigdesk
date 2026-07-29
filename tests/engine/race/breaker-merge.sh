#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/breaker.sh"

repeat=${TEST_REPEAT:-5}
for ((n=1; n<=repeat; n++)); do
  fingerprint="acct-$n"
  breaker_record alpha "$fingerprint" provider "" "" 10 100 provider &
  a=$!
  breaker_record alpha "$fingerprint" family fixture "" 11 100 family &
  b=$!
  breaker_record alpha "$fingerprint" model fixture model-a 12 100 model &
  c=$!
  wait "$a"; wait "$b"; wait "$c"
  count=$(find "$STATE_DIR/runners/breakers/v1/alpha/$fingerprint" \
    -maxdepth 1 -type f -name '*.state' | wc -l)
  [[ "$count" == 3 ]] || {
    test_fail "breaker merge loses no scope" "iteration=$n count=$count"
    finish_tests
    exit $?
  }
done
test_ok "breaker merge invariant survives $repeat repetitions"
finish_tests
