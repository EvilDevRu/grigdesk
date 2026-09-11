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

# Изменение модели не должно стирать объяснения остальных настроек проекта.
commented="$TEST_ROOT/commented.runners.env"
cat >"$commented" <<'ENV'
# Причина общего выбора.
RUNNERS_SCHEMA=1
CONFIG_REVISION=7
PROJECT_RUNNER_PRIMARY=codex

# Сильное ревью сохраняет независимую проверку.
MODEL_REVIEW_CLAUDE_EFFORT=max
# Разведка имеет собственную модель.
MODEL_SCOUT_CODEX_EFFORT=xhigh
ENV
profile_config_write "$commented" 7 MODEL_SCOUT_CODEX_FAMILY codex-spark MODEL_SCOUT_CODEX_EFFORT high
assert_rc 0 "$?" "model update preserves the annotated policy"
assert_contains "$(cat "$commented")" $'# Сильное ревью сохраняет независимую проверку.\nMODEL_REVIEW_CLAUDE_EFFORT=max' \
  "unrelated policy keeps its explanation next to its value"
assert_contains "$(cat "$commented")" $'# Разведка имеет собственную модель.\nMODEL_SCOUT_CODEX_EFFORT=high' \
  "changed model value keeps its explanation"
assert_eq codex-spark "$(profile_config_get "$commented" MODEL_SCOUT_CODEX_FAMILY)" \
  "new model key is included exactly once"
assert_eq 8 "$(profile_config_get "$commented" CONFIG_REVISION)" \
  "annotated policy still advances its CAS revision"
profile_config_validate "$commented"
assert_rc 0 "$?" "annotated model update remains valid canonical config"

finish_tests
