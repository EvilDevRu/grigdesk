#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture"
printf 'PROFILE_NAME=fixture\n' >"$FACTORY_PROFILES_DIR/fixture/profile.sh"

"$FACTORY_HOME/bin/factory" profile fixture runner set alpha --failover beta
assert_rc 0 "$?" "project runner policy is writable through factory CLI"
config="$FACTORY_PROFILES_DIR/fixture/runners.env"
assert_eq alpha "$(awk -F= '$1=="PROJECT_RUNNER_PRIMARY"{print $2}' "$config")" \
  "project primary is persisted canonically"
assert_eq beta "$(awk -F= '$1=="PROJECT_RUNNER_FAILOVER"{print $2}' "$config")" \
  "project failover is persisted canonically"

"$FACTORY_HOME/bin/factory" profile fixture runner set BUILD beta --failover alpha
assert_rc 0 "$?" "stage policy is writable through factory CLI"
show=$("$FACTORY_HOME/bin/factory" profile fixture runner show)
assert_contains "$show" "BUILD: beta -> alpha" "CLI shows stage-specific chain"

"$FACTORY_HOME/bin/factory" profile fixture model set BUILD beta \
  family=fixture version=latest variant=auto effort=high
assert_rc 0 "$?" "stage model family policy is writable through factory CLI"
assert_eq fixture "$(awk -F= '$1=="MODEL_BUILD_BETA_FAMILY"{print $2}' "$config")" \
  "model family is persisted separately from provider routing"
model_show=$("$FACTORY_HOME/bin/factory" profile fixture model show BUILD beta)
assert_contains "$model_show" "family=fixture" "CLI shows family policy without fixed model pair"

printf 'PROFILE=fixture\nRUN_PROTOCOL=2\n' >"$STATE_DIR/t77.pipeline"
"$FACTORY_HOME/bin/factory" 77 runner set alpha --failover beta
assert_rc 0 "$?" "task runner override is writable through factory CLI"
assert_eq alpha "$(awk -F= '$1=="RUNNER_OVERRIDE_PRIMARY"{print $2}' "$STATE_DIR/t77.pipeline")" \
  "task override uses pipeline store"

"$FACTORY_HOME/bin/factory" 77 runner set REVIEW beta --failover alpha
assert_rc 0 "$?" "task-stage override is writable through factory CLI"
"$FACTORY_HOME/bin/factory" 77 runner clear REVIEW
assert_rc 0 "$?" "task-stage override can be cleared"
assert_eq "" "$(awk -F= '$1=="RUNNER_OVERRIDE_STAGE_REVIEW"{print $2}' "$STATE_DIR/t77.pipeline")" \
  "clear removes effective task-stage chain"

"$FACTORY_HOME/bin/factory" 77 runner show >"$TEST_ROOT/show"
assert_rc 0 "$?" "task effective runner policy is readable"
assert_contains "$(cat "$TEST_ROOT/show")" "primary: alpha" "task show reports effective primary"

printf 'PROFILE_NAME=escape\n' >"$TEST_ROOT/escape.sh"
"$FACTORY_HOME/bin/factory" profile ../escape runner set alpha >/dev/null 2>&1
assert_rc 2 "$?" "profile name cannot escape profiles directory"
assert_file_missing "$TEST_ROOT/escape/runners.env" "invalid profile path writes nothing"

finish_tests
