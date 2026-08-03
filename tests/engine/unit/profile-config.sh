#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/profile-config.sh" ]]; then
  test_fail "profile config module exists" "missing lib/profile-config.sh"
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/profile-config.sh"

config="$TEST_ROOT/profile.runners.env"
profile_config_create "$config" claude codex
assert_rc 0 "$?" "canonical project config is created explicitly"
assert_eq 1 "$(profile_config_get "$config" RUNNERS_SCHEMA)" "schema is versioned"
assert_eq claude "$(profile_config_get "$config" PROJECT_RUNNER_PRIMARY)" "explicit primary is preserved"
assert_eq codex "$(profile_config_get "$config" PROJECT_RUNNER_FAILOVER)" "explicit failover is preserved"
assert_eq required "$(profile_config_get "$config" RUNNERS_COVERAGE)" \
  "migrated resilient config requires current coverage"

revision=$(profile_config_get "$config" CONFIG_REVISION)
profile_config_write "$config" "$revision" PROJECT_RUNNER_PRIMARY codex PROJECT_RUNNER_FAILOVER claude
assert_rc 0 "$?" "writer commits matching revision"
assert_eq codex "$(profile_config_get "$config" PROJECT_RUNNER_PRIMARY)" "writer changes primary"

profile_config_write "$config" "$revision" PROJECT_RUNNER_PRIMARY gemini >/dev/null 2>&1
assert_rc 72 "$?" "stale writer is rejected"
assert_eq codex "$(profile_config_get "$config" PROJECT_RUNNER_PRIMARY)" "stale writer loses no committed update"

revision=$(profile_config_get "$config" CONFIG_REVISION)
export FACTORY_TEST_CRASH_BEFORE_RENAME=1
profile_config_write "$config" "$revision" PROJECT_RUNNER_PRIMARY gemini >/dev/null 2>&1
assert_rc 99 "$?" "crash-before-rename is injectable"
unset FACTORY_TEST_CRASH_BEFORE_RENAME
assert_eq codex "$(profile_config_get "$config" PROJECT_RUNNER_PRIMARY)" "crash leaves old config intact"

revision=$(profile_config_get "$config" CONFIG_REVISION)
export FACTORY_TEST_CRASH_AFTER_RENAME=1
profile_config_write "$config" "$revision" PROJECT_RUNNER_PRIMARY gemini >/dev/null 2>&1
assert_rc 98 "$?" "crash-after-rename is injectable"
unset FACTORY_TEST_CRASH_AFTER_RENAME
assert_eq gemini "$(profile_config_get "$config" PROJECT_RUNNER_PRIMARY)" "crash after rename leaves new config intact"

profile_config_create "$config" gemini "" >/dev/null 2>&1
assert_rc 73 "$?" "create refuses to overwrite canonical config"
assert_eq gemini "$(profile_config_get "$config" PROJECT_RUNNER_PRIMARY)" \
  "refused create does not overwrite canonical config"

unknown="$TEST_ROOT/unknown.runners.env"
printf 'RUNNERS_SCHEMA=99\nCONFIG_REVISION=1\nPROJECT_RUNNER_PRIMARY=claude\n' >"$unknown"
profile_config_write "$unknown" 1 PROJECT_RUNNER_PRIMARY codex >/dev/null 2>&1
assert_rc 78 "$?" "unknown newer schema is not overwritten"

malicious="$TEST_ROOT/malicious.runners.env"
printf 'RUNNERS_SCHEMA=1\nCONFIG_REVISION=1\nPROJECT_RUNNER_PRIMARY=$(touch %s)\n' \
  "$TEST_ROOT/pwned" >"$malicious"
profile_config_validate "$malicious" >/dev/null 2>&1
assert_rc 2 "$?" "config is parsed, never sourced"
assert_file_missing "$TEST_ROOT/pwned" "malicious value is not executed"

finish_tests
