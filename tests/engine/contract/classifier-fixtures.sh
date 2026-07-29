#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

missing=0
for file in lib/runners/claude.sh lib/runners/codex.sh; do
  if [[ ! -f "$FACTORY_HOME/$file" ]]; then
    test_fail "$file exists" "missing $file"
    missing=1
  fi
done
if (( missing )); then
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/runners/index.sh"
runner_registry_reset
runner_registry_add claude "$FACTORY_HOME/lib/runners/claude.sh"
runner_registry_add codex "$FACTORY_HOME/lib/runners/codex.sh"
runner_contract_check claude
assert_rc 0 "$?" "Claude module passes runner contract"
runner_contract_check codex
assert_rc 0 "$?" "Codex module passes runner contract"
runner_call claude probe >/dev/null 2>&1
assert_rc 126 "$?" "Claude probe cannot escape offline executor"
runner_call codex probe >/dev/null 2>&1
assert_rc 126 "$?" "Codex probe cannot escape offline executor"

check_fixture() {
  local provider=$1 name=$2 dir expected actual rc
  dir="$FACTORY_TESTS_HOME/fixtures/classifiers/$name"
  for required in meta.env stderr.log stdout.log events.jsonl; do
    assert_file_exists "$dir/$required" "$name contains $required"
  done
  expected=$(awk -F= '$1=="EXPECTED_CLASS"{print $2}' "$dir/meta.env")
  rc=$(awk -F= '$1=="RC"{print $2}' "$dir/meta.env")
  actual=$(runner_call "$provider" classify "$dir" "$rc")
  assert_eq "$expected" "$actual" "$name classifies as expected"
}

check_fixture claude claude-synthetic-limit
check_fixture codex codex-synthetic-limit
check_fixture codex codex-denied

unknown="$TEST_ROOT/unknown-version"
cp -a "$FACTORY_TESTS_HOME/fixtures/classifiers/codex-denied" "$unknown"
sed -i 's/CLI_VERSION=.*/CLI_VERSION=999.0.0/' "$unknown/meta.env"
actual=$(runner_call codex classify "$unknown" 1)
assert_eq unknown "$actual" "unknown CLI version fails closed"

actual=$(bash --noprofile --norc -c \
  'source "$FACTORY_HOME/lib/runners/codex.sh"; runner_codex_classify "$1" 1' \
  _ "$FACTORY_TESTS_HOME/fixtures/classifiers/codex-denied")
assert_eq denied "$actual" "Codex classifier works standalone"

finish_tests
