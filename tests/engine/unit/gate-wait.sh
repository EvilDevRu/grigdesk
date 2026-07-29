#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/core.sh"

gate_state=pending
set_args=""

get() { printf '%s\n' "$gate_state"; }
set_st() {
  shift
  set_args="$*"
  gate_state=waiting
}
flog() { :; }
sleep() { gate_state=approved; }

gate_wait 42 GATE_ACCEPT

assert_eq approved "$GATE_DECISION" "gate returns the new human decision"
assert_eq "GATE_ACCEPT waiting GATE_ACCEPT_COMMENT " "$set_args" \
  "new gate wait clears the previous rejection comment"

finish_tests
