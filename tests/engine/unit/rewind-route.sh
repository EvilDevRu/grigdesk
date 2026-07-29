#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/core.sh"

updates=()
set_st() {
  shift
  updates+=("$*")
}

_rewind_route_to_stage 42 REVIEW BUILD REVIEW TRACE LINT GATE_ACCEPT SHIP
rc=$?

assert_rc 0 "$rc" "route rewind accepts a stage from the active route"
assert_eq "REVIEW pending" "${updates[0]-}" "selected stage is reset"
assert_eq "TRACE pending" "${updates[1]-}" "first downstream stage is reset"
assert_eq "LINT pending" "${updates[2]-}" "all downstream checks are reset"
assert_eq "GATE_ACCEPT pending" "${updates[3]-}" "acceptance gate is reopened"
assert_eq "SHIP pending" "${updates[4]-}" "shipping is reset"
assert_eq "REVIEW running REWIND_STAGE " "${updates[5]-}" \
  "selected stage becomes current and rewind control is consumed"

updates=()
_rewind_route_to_stage 42 UNKNOWN BUILD REVIEW GATE_ACCEPT
rc=$?

assert_rc 1 "$rc" "route rewind rejects a stage outside the active route"
assert_eq "REWIND_STAGE " "${updates[0]-}" "invalid rewind control is consumed"

finish_tests
