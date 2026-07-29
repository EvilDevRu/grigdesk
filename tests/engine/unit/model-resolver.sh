#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/runners/catalog.sh" ]]; then
  test_fail "catalog resolver exists" "missing lib/runners/catalog.sh"
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/runners/catalog.sh"

make_snapshot() {
  local dir=$1 source=$2 expires=$3 auth=$4 runner_version=$5 ready=${6:-1}
  mkdir -p "$dir"
  cat >"$dir/meta.env" <<EOF
SCHEMA=1
REVISION=$(basename "$dir")
SOURCE=$source
FETCHED_AT=100
EXPIRES_AT=$expires
RUNNER_VERSION=$runner_version
AUTH_FINGERPRINT=$auth
EOF
  cat >"$dir/models.tsv" <<'EOF'
claude-opus-4	claude	opus	4	default	40	1	0	1	0.100.0	0.200.0
claude-opus-5	claude	opus	5	default	50	1	0	1	0.100.0	0.200.0
claude-opus-6-beta	claude	opus	6	default	60	0	0	1	0.100.0	0.200.0
claude-opus-7-old	claude	opus	7	default	70	1	1	1	0.100.0	0.200.0
claude-opus-8-locked	claude	opus	8	default	80	1	0	0	0.100.0	0.200.0
claude-opus-5-1m	claude	opus	5	1m	50	1	0	1	0.100.0	0.200.0
claude-fable-9	claude	fable	9	default	90	1	0	1	0.100.0	0.200.0
codex-sol-56	codex	sol	5.6	default	56	1	0	1	0.140.0	0.150.0
EOF
  if [[ "$ready" == 1 ]]; then
    { cat "$dir/meta.env"; cat "$dir/models.tsv"; } | sha256sum | awk '{print $1}' >"$dir/READY"
  fi
}

catalog_root="$TEST_ROOT/catalogs"
make_snapshot "$catalog_root/live-r1" live 300 acct-a 0.145.0
make_snapshot "$catalog_root/cache-r1" cache 300 acct-a 0.145.0
make_snapshot "$catalog_root/cache-wrong-auth" cache 300 acct-b 0.145.0
make_snapshot "$catalog_root/seed-r1" seed-probed 0 acct-a 0.145.0
make_snapshot "$catalog_root/partial" live 300 acct-a 0.145.0 0

selected=$(catalog_snapshot_select "$catalog_root/live-r1" "$catalog_root/cache-r1" \
  "$catalog_root/seed-r1" 200 0.145.0 acct-a)
assert_eq "$catalog_root/live-r1" "$selected" "live snapshot wins"

selected=$(catalog_snapshot_select "$catalog_root/partial" "$catalog_root/cache-r1" \
  "$catalog_root/seed-r1" 200 0.145.0 acct-a)
assert_eq "$catalog_root/cache-r1" "$selected" "partial live snapshot recovers to cache"

selected=$(catalog_snapshot_select "$catalog_root/partial" "$catalog_root/cache-wrong-auth" \
  "$catalog_root/seed-r1" 200 0.145.0 acct-a)
assert_eq "$catalog_root/seed-r1" "$selected" "foreign cache is rejected before probed seed"

catalog_snapshot_verify "$catalog_root/cache-r1" 400 0.145.0 acct-a
assert_rc 1 "$?" "expired cache is rejected"
catalog_snapshot_verify "$catalog_root/cache-r1" 200 0.146.0 acct-a
assert_rc 1 "$?" "cache from another runner version is rejected"

actual=$(catalog_resolve "$catalog_root/live-r1" claude opus latest auto 0.145.0)
assert_eq claude-opus-5 "$actual" "latest uses highest eligible release order"

actual=$(catalog_resolve "$catalog_root/live-r1" claude opus 4 auto 0.145.0)
assert_eq claude-opus-4 "$actual" "version pin resolves inside family"

actual=$(catalog_resolve "$catalog_root/live-r1" claude opus latest 1m 0.145.0)
assert_eq claude-opus-5-1m "$actual" "explicit variant stays inside family"

catalog_resolve "$catalog_root/live-r1" claude missing latest auto 0.145.0 >/dev/null
assert_rc 4 "$?" "missing family returns no_candidate"

catalog_resolve "$catalog_root/live-r1" claude fable latest auto 0.145.0 >/dev/null
assert_rc 0 "$?" "new family is available only when explicitly requested"

actual=$(catalog_resolve_exact "$catalog_root/live-r1" codex codex-sol-56 0.145.0)
assert_eq codex-sol-56 "$actual" "exact pin resolves compatible id"

actual=$(catalog_resolve_exact "$catalog_root/live-r1" claude claude-opus-7-old 0.145.0)
assert_eq claude-opus-7-old "$actual" "exact pin remains reproducible while deprecated id is available"

catalog_resolve_exact "$catalog_root/live-r1" claude claude-opus-8-locked 0.145.0 >/dev/null
assert_rc 4 "$?" "exact pin unavailable to auth fails honestly"

finish_tests
