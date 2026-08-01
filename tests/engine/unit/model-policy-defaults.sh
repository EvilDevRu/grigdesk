#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/multi-runner.sh"

export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture"
PROFILE_NAME=fixture
config="$FACTORY_PROFILES_DIR/fixture/runners.env"
printf '%s\n' RUNNERS_SCHEMA=1 CONFIG_REVISION=1 \
  PROJECT_RUNNER_PRIMARY=claude PROJECT_RUNNER_FAILOVER= >"$config"

# Даже если старый проектный хук случайно остался в окружении, runtime его не читает.
profile_stage_model() { printf 'sonnet\n'; }
runner_registry_reset
runner_registry_add claude "$FACTORY_HOME/lib/runners/claude.sh"
runner_claude_probe() { printf '2.1.0\n'; }
MULTI_STAGE=BUILD
MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
declare -gA MULTI_PROBE_READY=()
declare -gA MULTI_PROBE_VERSION=()
declare -gA MULTI_PLAN_LEVEL=()
declare -gA MULTI_PLAN_DEGRADED=()

_multi_resolve claude ""
assert_rc 0 "$?" "provider default resolves without a fixed model map"
assert_eq opus "$DISPATCH_RESOLVED_FAMILY" "removed project hook cannot override provider default"
assert_eq opus "$DISPATCH_RESOLVED_MODEL" "Claude family alias resolves provider default"
_multi_catalog_cleanup

MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
_multi_catalog_model claude "" latest auto claude-opus-unknown 2.1.0 >/dev/null
assert_rc 4 "$?" "unverified exact model id fails closed without a catalog"
_multi_catalog_cleanup

# Семейство без каталога уходит в `--model` как есть, поэтому список алиасов раннера
# обязан совпадать с тем, что понимает установленный CLI: fable там есть, mythos нет.
MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
_multi_catalog_model claude fable latest auto "" 2.1.0 >/dev/null
assert_rc 0 "$?" "fable resolves through the Claude family alias"
assert_eq fable "$MULTI_RESOLVED_MODEL" "family alias reaches the CLI verbatim"
_multi_catalog_cleanup

MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
_multi_catalog_model claude mythos latest auto "" 2.1.0 >/dev/null
assert_rc 4 "$?" "family unknown to the CLI fails closed"
_multi_catalog_cleanup

finish_tests
