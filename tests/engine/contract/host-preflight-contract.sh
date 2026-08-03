#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/coverage.sh" ]]; then
  test_fail "coverage module exists" "missing lib/coverage.sh"
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/coverage.sh"

bin_ok="$TEST_ROOT/fake-tool"
printf '#!/usr/bin/env bash\necho 1.0\n' >"$bin_ok"
chmod +x "$bin_ok"
readable="$TEST_ROOT/readable"
writable="$TEST_ROOT/writable"
printf x >"$readable"; mkdir -p "$writable"

manifest="$TEST_ROOT/host.tsv"
cat >"$manifest" <<EOF
executable	fake-tool	$bin_ok
readable	fixture	$readable
writable	fixture	$writable
EOF

artifact="$TEST_ROOT/host.env"
coverage_host_preflight "$manifest" structural-hash catalog-r1 100 60 "$artifact"
assert_rc 0 "$?" "host preflight succeeds without model call"
assert_eq 0 "$(coverage_artifact_get "$artifact" UNAVAILABLE)" "all host requirements are ready"
assert_eq 160 "$(coverage_artifact_get "$artifact" EXPIRES_AT)" "host artifact has TTL"

printf 'executable\tmissing\t%s\n' "$TEST_ROOT/missing" >>"$manifest"
coverage_host_preflight "$manifest" structural-hash catalog-r1 100 60 "$TEST_ROOT/host-bad.env"
assert_rc 1 "$?" "missing host binary fails preflight"
assert_eq 1 "$(coverage_artifact_get "$TEST_ROOT/host-bad.env" UNAVAILABLE)" \
  "missing host requirement is counted"

finish_tests
