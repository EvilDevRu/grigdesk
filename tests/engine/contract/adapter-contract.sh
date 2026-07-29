#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/adapters/index.sh" ]]; then
  test_fail "adapter registry exists" "missing lib/adapters/index.sh"
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/adapters/index.sh"

adapter_registry_reset
adapter_registry_add fanout "$FACTORY_TESTS_HOME/fakes/adapters/fanout.sh"
assert_rc 0 "$?" "fake adapter registers"
adapter_contract_check fanout
assert_rc 0 "$?" "fake adapter passes contract"
assert_eq 1 "$(adapter_call fanout version)" "adapter exposes version"
assert_eq fanout "$(adapter_call fanout provides)" "adapter declares provided capability"
adapter_call fanout preflight
assert_rc 0 "$?" "adapter preflight succeeds"

bad="$TEST_ROOT/bad-adapter.sh"
printf 'adapter_bad_version() { echo 1; }\n' >"$bad"
adapter_registry_add bad "$bad"
adapter_contract_check bad >/dev/null 2>&1
assert_rc 1 "$?" "incomplete adapter fails contract"

finish_tests
