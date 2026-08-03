#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/runners/policy.sh" ]]; then
  test_fail "transition policy exists" "missing lib/runners/policy.sh"
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/runners/policy.sh"

check_transition() {
  local expected=$1 phase=$2 reason=$3 mode=$4 matched=$5 name=$6 rc
  runner_transition_allowed "$phase" "$reason" "$mode" "$matched"
  rc=$?
  assert_rc "$expected" "$rc" "$name"
}

check_transition 0 preflight unavailable_preflight auto 0 "missing CLI can skip before model start"
check_transition 0 preflight route_unavailable auto 0 "unexecutable route can skip before model start"
check_transition 1 preflight limited auto 0 "fresh limited classification is not preflight"
check_transition 1 preflight manual_switch manual 1 "manual switch is not forged before active run"

check_transition 0 started limited auto 0 "proven limit can fail over after model start"
check_transition 0 started provider_unavailable auto 0 \
  "proven provider refusal without model activity can fail over"
check_transition 0 started manual_switch manual 1 "matching manual switch can replace active run"
check_transition 1 started manual_switch manual 0 "unmatched manual switch is rejected"
check_transition 1 started unavailable_preflight auto 0 "late auth error is not relabeled preflight"
check_transition 1 started route_unavailable auto 0 "late adapter error is not relabeled route unavailable"

for reason in ok agent_failed missing_status denied timeout transient invalid_config \
              context_overflow crashed unknown; do
  check_transition 1 preflight "$reason" auto 0 "$reason never moves provider before start"
  check_transition 1 started "$reason" auto 0 "$reason never moves provider after start"
done

runner_result_class_valid limited
assert_rc 0 "$?" "known result class is valid"
runner_result_class_valid made_up
assert_rc 1 "$?" "unknown result class is invalid"

finish_tests
