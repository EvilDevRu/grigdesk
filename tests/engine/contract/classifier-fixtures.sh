#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

missing=0
for file in lib/runners/claude.sh lib/runners/codex.sh lib/runners/kimi.sh; do
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
source "$FACTORY_HOME/lib/executor.sh"
runner_registry_reset
runner_registry_add claude "$FACTORY_HOME/lib/runners/claude.sh"
runner_registry_add codex "$FACTORY_HOME/lib/runners/codex.sh"
runner_registry_add kimi "$FACTORY_HOME/lib/runners/kimi.sh"
runner_contract_check claude
assert_rc 0 "$?" "Claude module passes runner contract"
runner_contract_check codex
assert_rc 0 "$?" "Codex module passes runner contract"
runner_contract_check kimi
assert_rc 0 "$?" "Kimi module passes runner contract"
runner_call claude probe >/dev/null 2>&1
assert_rc 126 "$?" "Claude probe cannot escape offline executor"
runner_call codex probe >/dev/null 2>&1
assert_rc 126 "$?" "Codex probe cannot escape offline executor"
runner_call kimi probe >/dev/null 2>&1
assert_rc 126 "$?" "Kimi probe cannot escape offline executor"

# Пин проводки: OFFLINE_GUARD в engine/lib/executor.sh пока не знает basename
# kimi (пункт `kimi|kimi-*` из плана). Тест RED до обновления executor.sh:
# сейчас stub отрабатывает с rc=0 вместо блокировки 126.
for name in kimi kimi-beta; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$TEST_ROOT/$name"
  chmod +x "$TEST_ROOT/$name"
  factory_exec local "$TEST_ROOT/$name" >/dev/null 2>&1
  assert_rc 126 "$?" "$name basename denied even when mislabeled local"
done

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
check_fixture claude claude-auth-expired
check_fixture claude claude-auth-corrupt-stream
check_fixture claude claude-request-not-allowed
check_fixture claude claude-request-not-allowed-after-work
check_fixture claude claude-context-overflow
check_fixture claude claude-weekly-limit
check_fixture claude claude-runtime-weekly-limit
check_fixture claude claude-rate-limit
check_fixture codex codex-synthetic-limit
check_fixture codex codex-denied
check_fixture codex codex-auth-expired
check_fixture codex codex-auth-corrupt-stream
check_fixture codex codex-context-overflow
check_fixture kimi kimi-ok
check_fixture kimi kimi-no-login
check_fixture kimi kimi-bad-model
check_fixture kimi kimi-interrupted
check_fixture kimi kimi-auth-after-work

unknown="$TEST_ROOT/unknown-version"
cp -a "$FACTORY_TESTS_HOME/fixtures/classifiers/codex-denied" "$unknown"
sed -i 's/CLI_VERSION=.*/CLI_VERSION=999.0.0/' "$unknown/meta.env"
actual=$(runner_call codex classify "$unknown" 1)
assert_eq unknown "$actual" "unknown CLI version fails closed"

kimi_unknown="$TEST_ROOT/kimi-unknown-version"
cp -a "$FACTORY_TESTS_HOME/fixtures/classifiers/kimi-no-login" "$kimi_unknown"
sed -i 's/CLI_VERSION=.*/CLI_VERSION=999.0.0/' "$kimi_unknown/meta.env"
actual=$(runner_call kimi classify "$kimi_unknown" 1)
assert_eq unknown "$actual" "unknown Kimi CLI version fails closed"

kimi_unverified="$TEST_ROOT/kimi-unverified-fixture"
cp -a "$FACTORY_TESTS_HOME/fixtures/classifiers/kimi-no-login" "$kimi_unverified"
sed -i 's/FIXTURE_VERIFIED=.*/FIXTURE_VERIFIED=0/' "$kimi_unverified/meta.env"
actual=$(runner_call kimi classify "$kimi_unverified" 1)
assert_eq unknown "$actual" "unverified Kimi fixture fails closed"

actual=$(bash --noprofile --norc -c \
  'source "$FACTORY_HOME/lib/runners/codex.sh"; runner_codex_classify "$1" 1' \
  _ "$FACTORY_TESTS_HOME/fixtures/classifiers/codex-denied")
assert_eq denied "$actual" "Codex classifier works standalone"

finish_tests
