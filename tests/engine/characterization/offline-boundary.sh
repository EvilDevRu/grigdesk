#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/executor.sh" ]]; then
  test_fail "executor boundary exists" "missing lib/executor.sh"
  finish_tests
  exit $?
fi

source "$FACTORY_HOME/lib/executor.sh"

factory_exec provider claude --version >/dev/null 2>&1
assert_rc 126 "$?" "provider executable denied by name"

factory_exec provider /usr/bin/true >/dev/null 2>&1
assert_rc 126 "$?" "provider executable denied by absolute path"

factory_exec network /usr/bin/curl https://example.invalid >/dev/null 2>&1
assert_rc 126 "$?" "network executable denied by absolute path"

factory_exec local /bin/true >/dev/null 2>&1
assert_rc 0 "$?" "local allowlisted executable runs"

printf '#!/usr/bin/env bash\nexit 0\n' >"$TEST_ROOT/curl"
chmod +x "$TEST_ROOT/curl"
factory_exec local "$TEST_ROOT/curl" >/dev/null 2>&1
assert_rc 126 "$?" "network basename denied even when mislabeled local"

printf 'secret-canary\n' >"$TEST_ROOT/canary.auth"
factory_read_file "$TEST_ROOT/canary.auth" >/dev/null 2>&1
assert_rc 126 "$?" "read outside configured roots denied"

printf 'fixture\n' >"$FACTORY_CONFIG_ROOT/fixture.txt"
value=$(factory_read_file "$FACTORY_CONFIG_ROOT/fixture.txt")
rc=$?
assert_rc 0 "$rc" "read inside configured roots allowed"
assert_eq fixture "$value" "allowed read returns content"

finish_tests
