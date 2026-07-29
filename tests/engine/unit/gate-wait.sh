#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/core.sh"

gate_state=pending
rewind_stage=
set_args=""

get() {
  case "$2" in
    GATE_ACCEPT) printf '%s\n' "$gate_state" ;;
    REWIND_STAGE) printf '%s\n' "$rewind_stage" ;;
    *) printf '\n' ;;
  esac
}
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

# «Перейти сюда» на уже открытых воротах — не человеческий reject. Движок должен
# проснуться отдельным решением, чтобы вернуть именно выбранный этап, а не весь BUILD.
gate_state=waiting
rewind_stage=REVIEW
set_args=""
gate_wait 42 GATE_ACCEPT

assert_eq rewind "$GATE_DECISION" "manual rewind wakes a daemon waiting at a gate"

finish_tests
