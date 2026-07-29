#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/coverage.sh" ]]; then
  test_fail "coverage module exists" "missing lib/coverage.sh"
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/coverage.sh"

structural="$TEST_ROOT/structural.env"
host="$TEST_ROOT/host.env"
cat >"$structural" <<'EOF'
SCHEMA=1
KIND=structural
HASH=s-hash
CATALOG_REVISION=r2
UNAVAILABLE=0
EOF
cat >"$host" <<'EOF'
SCHEMA=1
KIND=host
HASH=h-hash
STRUCTURAL_HASH=s-hash
CATALOG_REVISION=r2
UNAVAILABLE=0
EXPIRES_AT=300
EOF

catalog_state="$TEST_ROOT/catalog-state"
mkdir -p "$catalog_state"
printf 'r1\n' >"$catalog_state/active"
coverage_catalog_promote "$catalog_state" r2 "$structural" "$host" 200
assert_rc 0 "$?" "candidate promotes when both layers are current"
assert_eq r2 "$(cat "$catalog_state/active")" "active catalog revision changes atomically"

printf 'r1\n' >"$catalog_state/active"
coverage_catalog_promote "$catalog_state" r2 "$structural" "$host" 400 >/dev/null 2>&1
assert_rc 77 "$?" "expired host artifact blocks promotion"
assert_eq r1 "$(cat "$catalog_state/active")" "failed promotion keeps previous active revision"

sed -i 's/UNAVAILABLE=0/UNAVAILABLE=1/' "$structural"
coverage_catalog_promote "$catalog_state" r2 "$structural" "$host" 200 >/dev/null 2>&1
assert_rc 77 "$?" "structural unavailable blocks promotion"

sed -i 's/UNAVAILABLE=1/UNAVAILABLE=0/' "$structural"
sed -i 's/STRUCTURAL_HASH=s-hash/STRUCTURAL_HASH=other-hash/' "$host"
coverage_catalog_promote "$catalog_state" r2 "$structural" "$host" 200 >/dev/null 2>&1
assert_rc 77 "$?" "host artifact for another structural hash blocks promotion"

coverage_catalog_promote "$catalog_state" r2 "$structural" "$host" not-a-time >/dev/null 2>&1
assert_rc 77 "$?" "non-numeric gate clock fails closed"

finish_tests
