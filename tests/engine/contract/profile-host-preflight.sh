#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/profile-preflight.sh" ]]; then
  test_fail "profile preflight module exists" "missing lib/profile-preflight.sh"
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/profile-preflight.sh"

export FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture"
config="$FACTORY_PROFILES_DIR/fixture/runners.env"
printf '%s\n' \
  RUNNERS_SCHEMA=1 CONFIG_REVISION=1 \
  PROJECT_RUNNER_PRIMARY=alpha PROJECT_RUNNER_FAILOVER=beta \
  MODEL_DEFAULT_ALPHA_FAMILY=fixture MODEL_DEFAULT_ALPHA_VERSION=latest \
  MODEL_DEFAULT_BETA_FAMILY=fixture MODEL_DEFAULT_BETA_VERSION=latest >"$config"

profile_runner_host_preflight fixture 100 60
assert_rc 0 "$?" "profile host preflight succeeds without a model call"
structural="$STATE_DIR/coverage/fixture/structural.env"
host="$STATE_DIR/coverage/fixture/host.env"
assert_file_exists "$structural" "profile preflight writes structural artifact"
assert_file_exists "$host" "profile preflight writes host artifact"
assert_eq 2 "$(coverage_artifact_get "$structural" SCHEMA)" "структурное покрытие имеет схему 2"
assert_eq 2 "$(coverage_artifact_get "$host" SCHEMA)" "хостовое покрытие имеет схему 2"
assert_eq native "$(coverage_artifact_get "$structural" PROVIDER_alpha)" \
  "структурное покрытие хранит именной уровень"
assert_eq ready "$(coverage_artifact_get "$host" PROVIDER_beta)" "хост хранит именную готовность"
assert_eq 0 "$(coverage_artifact_get "$host" UNAVAILABLE)" "both configured providers are ready"
assert_eq "" "$(coverage_artifact_get "$host" UNAVAILABLE_RUNNERS)" \
  "ready preflight publishes an empty runner detail"
assert_file_missing "$TEST_ROOT/invocations" "preflight never invokes runner run method"

export FAKE_BETA_PROBE=missing
profile_runner_host_preflight fixture 200 60 >/dev/null 2>&1
assert_rc 1 "$?" "unavailable failover makes host preflight fail closed"
assert_eq 1 "$(coverage_artifact_get "$host" UNAVAILABLE)" \
  "unavailable configured provider is counted"
assert_eq beta "$(coverage_artifact_get "$host" UNAVAILABLE_RUNNERS)" \
  "host artifact names the unavailable configured provider"
assert_eq ready "$(coverage_artifact_get "$host" PROVIDER_alpha)" "соседняя готовность сохранена"
assert_eq unavailable "$(coverage_artifact_get "$host" PROVIDER_beta)" "отказ записан только провайдеру"

mktemp() { return 1; }
profile_runner_host_preflight fixture 300 60 >/dev/null 2>&1
storage_rc=$?
unset -f mktemp
assert_rc 78 "$storage_rc" "coverage storage failure cannot report preflight success"

# Реальный DeepSeek adapter проверяется своими unit/contract-тестами; здесь нужен
# только профильный инвариант: metadata probe каждого кандидата обязателен, run/prompt
# во время host-preflight недопустим.
deepseek_runners="$TEST_ROOT/deepseek-runners"
mkdir -p "$deepseek_runners"
cp "$FACTORY_TESTS_HOME/fakes/runners/alpha.sh" "$deepseek_runners/alpha.sh"
printf '%s\n' \
  'runner_deepseek_probe() { [[ "${FAKE_DEEPSEEK_PROBE:-ready}" == ready ]] || return 4; printf "0.1.5-rc.2\\n"; }' \
  'runner_deepseek_catalog() { printf '\''["deepseek-official","deepseek-v4-flash"]\tdeepseek\tdefault\t1\tdefault\t100\t1\t0\t1\t0.1.5-rc.2\t0.1.5-rc.2\n'\''; }' \
  'runner_deepseek_default_policy() { printf "FAMILY=default\\nVERSION=latest\\nVARIANT=auto\\nEFFORT=high\\n"; }' \
  'runner_deepseek_family_alias() { return 4; }' \
  'runner_deepseek_capabilities() { printf "status status_request tools structured_output\\n"; }' \
  'runner_deepseek_run() { : >"${TEST_ROOT:?}/deepseek-run-called"; }' \
  'runner_deepseek_classify() { [[ "$2" == 0 ]] && printf "ok\\n" || printf "unknown\\n"; }' \
  'runner_deepseek_fanout_count() { printf "0\\n"; }' \
  'runner_deepseek_dialect() { printf "fixture\\n"; }' \
  'runner_deepseek_interrupt() { return 0; }' >"$deepseek_runners/deepseek.sh"

mkdir -p "$FACTORY_PROFILES_DIR/deepseek-fixture"
deepseek_config="$FACTORY_PROFILES_DIR/deepseek-fixture/runners.env"
printf '%s\n' \
  RUNNERS_SCHEMA=1 CONFIG_REVISION=1 \
  PROJECT_RUNNER_PRIMARY=alpha PROJECT_RUNNER_FAILOVER=deepseek \
  MODEL_DEFAULT_ALPHA_FAMILY=fixture MODEL_DEFAULT_ALPHA_VERSION=latest \
  MODEL_DEFAULT_DEEPSEEK_FAMILY=default MODEL_DEFAULT_DEEPSEEK_VERSION=latest \
  >"$deepseek_config"
export FACTORY_RUNNERS_DIR="$deepseek_runners"
unset FAKE_DEEPSEEK_PROBE
profile_runner_host_preflight deepseek-fixture 400 60
assert_rc 0 "$?" "profile preflight accepts metadata-ready DeepSeek without a prompt"
assert_file_missing "$TEST_ROOT/deepseek-run-called" "metadata preflight never calls DeepSeek run"
deepseek_host="$STATE_DIR/coverage/deepseek-fixture/host.env"
assert_eq '' "$(coverage_artifact_get "$deepseek_host" UNAVAILABLE_RUNNERS)" \
  "ready DeepSeek is covered as a configured failover"

export FAKE_DEEPSEEK_PROBE=missing
profile_runner_host_preflight deepseek-fixture 500 60 >/dev/null 2>&1
assert_rc 1 "$?" "строгий профильный preflight сообщает недоступность DeepSeek"
assert_eq deepseek "$(coverage_artifact_get "$deepseek_host" UNAVAILABLE_RUNNERS)" \
  "host artifact names DeepSeek as the unavailable candidate"

finish_tests
