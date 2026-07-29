#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/debug-settings.sh" ]]; then
  test_fail "debug settings module exists" "missing lib/debug-settings.sh"
  finish_tests
  exit $?
fi

source "$FACTORY_HOME/lib/debug-settings.sh"

export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture"
printf 'PROFILE_NAME=fixture\n' >"$FACTORY_PROFILES_DIR/fixture/profile.sh"
printf '%s\n' \
  'RUNNERS_SCHEMA=1' \
  'CONFIG_REVISION=7' \
  'PROJECT_RUNNER_PRIMARY=alpha' \
  'PROJECT_RUNNER_FAILOVER=beta' >"$FACTORY_PROFILES_DIR/fixture/runners.env"
printf 'PROFILE=fixture\n' >"$STATE_DIR/t71.pipeline"

value=$(debug_settings_resolve fixture 71 100)
assert_contains "$value" "LEVEL=off" "debug defaults to off"
assert_contains "$value" "SOURCE=default" "default source is explicit"

global_file=$(debug_settings_global_file)
debug_settings_write "$global_file" 0 decisions 0
assert_rc 0 "$?" "global debug setting is written atomically"
assert_eq 1 "$(debug_settings_get "$global_file" CONFIG_REVISION)" \
  "debug settings have an independent revision"
assert_eq 600 "$(stat -c %a "$global_file")" "debug settings file is private"

value=$(debug_settings_resolve fixture 71 100)
assert_contains "$value" "LEVEL=decisions" "global level is inherited"
assert_contains "$value" "SOURCE=global" "global source is reported"

profile_file=$(debug_settings_profile_file fixture)
debug_settings_write "$profile_file" 0 errors 0
assert_rc 0 "$?" "profile debug override is independent"
value=$(debug_settings_resolve fixture 71 100)
assert_contains "$value" "LEVEL=errors" "profile overrides global"
assert_contains "$value" "SOURCE=profile" "profile source is reported"

debug_settings_task_write 71 verbose 200
assert_rc 0 "$?" "task debug override is stored through task state"
value=$(debug_settings_resolve fixture 71 100)
assert_contains "$value" "LEVEL=verbose" "live task override has highest priority"
assert_contains "$value" "SOURCE=task" "task source is reported"
value=$(debug_settings_resolve fixture 71 201)
assert_contains "$value" "LEVEL=errors" "expired task override is ignored"
assert_contains "$value" "SOURCE=profile" "expired task falls back to profile"

revision=$(debug_settings_get "$profile_file" CONFIG_REVISION)
debug_settings_write "$profile_file" "$revision" off 0
assert_rc 0 "$?" "explicit profile off is writable"
value=$(debug_settings_resolve fixture "" 100)
assert_contains "$value" "LEVEL=off" "explicit off overrides enabled global setting"

revision=$(debug_settings_get "$profile_file" CONFIG_REVISION)
debug_settings_write "$profile_file" "$revision" inherit 0
assert_rc 0 "$?" "clear is represented as inherit"
value=$(debug_settings_resolve fixture "" 100)
assert_contains "$value" "LEVEL=decisions" "cleared profile inherits global level"

debug_settings_write "$profile_file" "$revision" verbose 0 >/dev/null 2>&1
assert_rc 72 "$?" "stale debug settings writer is rejected"
assert_eq inherit "$(debug_settings_get "$profile_file" LEVEL)" \
  "stale writer preserves committed setting"

revision=$(debug_settings_get "$profile_file" CONFIG_REVISION)
debug_settings_write "$profile_file" "$revision" secret 0 >/dev/null 2>&1
assert_rc 2 "$?" "unknown debug level is rejected"
assert_eq inherit "$(debug_settings_get "$profile_file" LEVEL)" \
  "invalid level does not mutate settings"

assert_eq 7200 "$(debug_settings_duration_seconds 2h)" "hour duration is parsed"
assert_eq 900 "$(debug_settings_duration_seconds 15m)" "minute duration is parsed"
debug_settings_duration_seconds forever >/dev/null 2>&1
assert_rc 2 "$?" "unbounded task duration is rejected"

routing_hash_before=$(sha256sum "$FACTORY_PROFILES_DIR/fixture/runners.env" | awk '{print $1}')
FACTORY_DEBUG_NOW=1000 "$FACTORY_HOME/bin/factory" settings debug set verbose
assert_rc 0 "$?" "global debug level is configurable through factory"
FACTORY_DEBUG_NOW=1000 "$FACTORY_HOME/bin/factory" profile fixture debug set errors
assert_rc 0 "$?" "profile debug level is configurable through factory"
FACTORY_DEBUG_NOW=1000 "$FACTORY_HOME/bin/factory" 71 debug set verbose --for 2h
assert_rc 0 "$?" "task debug level supports automatic expiry"
show=$(FACTORY_DEBUG_NOW=1000 "$FACTORY_HOME/bin/factory" 71 debug show)
assert_contains "$show" "effective: verbose" "task CLI shows effective level"
assert_contains "$show" "source: task" "task CLI shows override source"
FACTORY_DEBUG_NOW=1000 "$FACTORY_HOME/bin/factory" 71 debug clear
assert_rc 0 "$?" "task debug override can be cleared"
show=$(FACTORY_DEBUG_NOW=1000 "$FACTORY_HOME/bin/factory" 71 debug show)
assert_contains "$show" "effective: errors" "clear restores profile level"
routing_hash_after=$(sha256sum "$FACTORY_PROFILES_DIR/fixture/runners.env" | awk '{print $1}')
assert_eq "$routing_hash_before" "$routing_hash_after" \
  "debug CLI never changes runner config revision or coverage input"

duplicate_file=$(debug_settings_profile_file duplicate)
mkdir -p "$(dirname "$duplicate_file")"
printf '%s\n' \
  'DEBUG_SCHEMA=1' \
  'CONFIG_REVISION=1' \
  'LEVEL=off' \
  'LEVEL=verbose' \
  'EXPIRES_AT=0' >"$duplicate_file"
value=$(debug_settings_resolve duplicate "" 100)
assert_contains "$value" "LEVEL=off" "duplicate setting keys fail closed"
assert_contains "$value" "SOURCE=invalid_profile" "corrupt settings source is visible"

octal_file=$(debug_settings_profile_file octal)
printf '%s\n' \
  'DEBUG_SCHEMA=1' \
  'CONFIG_REVISION=1' \
  'LEVEL=verbose' \
  'EXPIRES_AT=08' >"$octal_file"
value=$(debug_settings_resolve octal "" 100 2>"$TEST_ROOT/octal.err")
assert_contains "$value" "LEVEL=off" "non-canonical numeric setting fails closed"
assert_contains "$value" "SOURCE=invalid_profile" "malformed expiry is reported as invalid"
assert_eq "" "$(cat "$TEST_ROOT/octal.err")" "malformed expiry produces no arithmetic diagnostics"

printf 'PROFILE=fixture\n' >"$STATE_DIR/t72.pipeline"
FACTORY_DEBUG_TASK_DEFAULT_TTL='1+1' FACTORY_DEBUG_NOW=1000 \
  "$FACTORY_HOME/bin/factory" 72 debug set decisions >/dev/null 2>&1
assert_rc 2 "$?" "task default TTL accepts digits, not arithmetic expressions"
assert_eq "" "$(pipeline_store_get 72 DEBUG_LEVEL)" \
  "invalid default TTL leaves task state unchanged"

finish_tests
