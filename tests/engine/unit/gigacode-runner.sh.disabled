#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/multi-runner.sh"

module="$FACTORY_HOME/lib/runners/gigacode.sh"
if [[ ! -f "$module" ]]; then
  test_fail 'GigaCode runner существует до проверки поведения' "$module"
  finish_tests
  exit $?
fi
runner_registry_reset
runner_registry_add gigacode "$module"
assert_rc 0 "$?" 'GigaCode регистрируется обычным реестром'
runner_contract_check gigacode
assert_rc 0 "$?" 'Восемь обязательных методов реализованы'

caps=$(runner_call gigacode capabilities)
assert_contains "$caps" status_request 'Статус идёт через host request consumer'
for absent in sandbox fanout native_resume_v1 status_fd; do
  [[ " $caps " != *" $absent "* ]]
  assert_rc 0 "$?" "Нет недоказанной capability $absent"
done
(
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  unset GRIGDESK_GIGACODE_NODE_BIN NODE_BIN
  runner_call gigacode probe >"$TEST_ROOT/no-node-probe.log" 2>&1
)
assert_rc 4 "$?" 'Без host-owned Node probe отказывает до вызова provider'
export GRIGDESK_GIGACODE_NODE_BIN="$NODE_BIN"
runner_call gigacode probe >/dev/null 2>&1
assert_rc 126 "$?" 'Metadata provider process также закрыт offline guard'

# Только metadata catalog подменён синтетическим: здесь проверяется общий resolver.
# Реальная CLI-discovery и запуск отдельно проходят сквозной Node-тест с namespace.
runner_gigacode_probe() { printf '26.7.33\n'; }
runner_gigacode_credential_fingerprint() { printf '%064d\n' 1; }
runner_gigacode_catalog() {
  printf '%s\n' $'synthetic/model-a(gigacode)\tgigacode\tsynthetic/model-a(gigacode)\t1\tdefault\t1\t1\t0\t1\t26.7.33\t26.7.33'
}
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
PROFILE_NAME=fixture
mkdir -p "$FACTORY_PROFILES_DIR/$PROFILE_NAME"
config="$FACTORY_PROFILES_DIR/$PROFILE_NAME/runners.env"
MULTI_STAGE=BUILD
declare -gA MULTI_PROBE_READY=()
declare -gA MULTI_PROBE_VERSION=()
declare -gA MULTI_PLAN_LEVEL=()
declare -gA MULTI_PLAN_DEGRADED=()

for policy in '' 'MODEL_BUILD_GIGACODE_EXACT=synthetic/model-a(gigacode)' \
  'MODEL_BUILD_GIGACODE_FAMILY=synthetic/model-a(gigacode)'; do
  printf '%s\n' RUNNERS_SCHEMA=1 CONFIG_REVISION=1 PROJECT_RUNNER_PRIMARY=gigacode \
    PROJECT_RUNNER_FAILOVER= "$policy" >"$config"
  MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
  _multi_resolve gigacode ''
  assert_rc 0 "$?" "Policy без effort разрешена: $policy"
  assert_eq '' "$DISPATCH_RESOLVED_EFFORT" 'Отсутствие effort не превращается в high'
  assert_eq 'synthetic/model-a(gigacode)' "$DISPATCH_RESOLVED_MODEL" 'Opaque id сохранён'
  _multi_catalog_cleanup
done
printf '%s\n' MODEL_BUILD_GIGACODE_EFFORT=high >>"$config"
MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
_multi_resolve gigacode ''
assert_eq high "$DISPATCH_RESOLVED_EFFORT" 'Явное неподдерживаемое усилие не стирается resolver-ом'
_multi_catalog_cleanup

# Один native account не смешивает breaker разных профилей по скрытому default.
credential_before=$DISPATCH_CREDENTIAL_FINGERPRINT
mkdir -p "$FACTORY_PROFILES_DIR/other-fixture"
cp "$config" "$FACTORY_PROFILES_DIR/other-fixture/runners.env"
PROFILE_NAME=other-fixture
MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
_multi_resolve gigacode ''
[[ "$credential_before" != "$DISPATCH_CREDENTIAL_FINGERPRINT" ]]
assert_rc 0 "$?" 'Разные профили не разделяют breaker native account случайно'
_multi_catalog_cleanup
PROFILE_NAME=fixture

# Явное effort при отсутствующей model policy не должно исчезнуть в default_policy.
printf '%s\n' RUNNERS_SCHEMA=1 CONFIG_REVISION=1 PROJECT_RUNNER_PRIMARY=gigacode \
  PROJECT_RUNNER_FAILOVER= MODEL_BUILD_GIGACODE_EFFORT=unsupported >"$config"
MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
_multi_resolve gigacode ''
assert_rc 0 "$?" 'Resolver сохраняет явное усилие отдельно от выбора модели по умолчанию'
assert_eq unsupported "$DISPATCH_RESOLVED_EFFORT" 'default_policy не затирает явный effort'
_multi_catalog_cleanup

printf '%s\n' RUNNERS_SCHEMA=1 CONFIG_REVISION=1 PROJECT_RUNNER_PRIMARY=gigacode \
  PROJECT_RUNNER_FAILOVER= >"$config"
runner_gigacode_default_effort() { return 4; }
MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
_multi_resolve gigacode ''
assert_rc 4 "$?" 'Ошибка default_effort закрывает resolver'
assert_eq invalid_config "$DISPATCH_RESOLVE_RESULT" 'Ошибка hook не возвращает скрытый high'
_multi_catalog_cleanup

for requirement in single:1:forbid parallel:2:forbid parallel:2:allow-single; do
  IFS=: read -r FACTORY_ROUTE_FANOUT_MODE FACTORY_ROUTE_FANOUT_MAX \
    FACTORY_ROUTE_FANOUT_DEGRADE <<<"$requirement"
  MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
  _multi_execution_plan gigacode
  rc=$?
  case "$requirement" in
    single:*) expected=native; expected_rc=0 ;;
    *:forbid) expected=unavailable; expected_rc=1 ;;
    *) expected=degraded; expected_rc=0 ;;
  esac
  assert_rc "$expected_rc" "$rc" "$requirement проверяет допуск конкретного runner"
  assert_eq "$expected" "${MULTI_PLAN_LEVEL[gigacode]}" "$requirement имеет честный PLAN_LEVEL"
  _multi_catalog_cleanup
done

run_dir="$TEST_ROOT/giga-events"
mkdir -p "$run_dir"
printf '%s\n' 'CLI_VERSION=26.7.33' 'SOURCE=runtime' >"$run_dir/meta.env"
for code in 0 124 1; do
  actual=$(runner_call gigacode classify "$run_dir" "$code")
  case "$code" in 0) expected=ok ;; 124) expected=timeout ;; *) expected=unknown ;; esac
  assert_eq "$expected" "$actual" "rc=$code классифицируется без текстовых догадок"
done
printf '%s\n' 'CLI_VERSION=26.8.0' >"$run_dir/meta.env"
printf '%s\n' '{"event":"run_error","schema":"gigacode-acp-v1","phase":"pre-prompt","code":"gigacode_auth_required"}' \
  >"$run_dir/events.jsonl"
for code in 1 4 76 124; do
  actual=$(runner_call gigacode classify "$run_dir" "$code")
  expected=unknown
  [[ "$code" != 124 ]] || expected=timeout
  assert_eq "$expected" "$actual" "Непроверенная 26.8.0 не разрешает failover при rc=$code"
done
printf '%s\n' '{"event":"agent_message_chunk","text":"401 quota exceeded agent"}' \
  '{"event":"tool_call","name":"read_file","toolCallId":"one"}' >"$run_dir/events.jsonl"
assert_eq 0 "$(runner_call gigacode fanout_count "$run_dir")" 'Описание и текст не делегирование'
printf '%s\n' '{"event":"tool_call","name":"agent","toolCallId":"two"}' \
  '{"event":"tool_call_update","name":"agent","toolCallId":"two"}' >>"$run_dir/events.jsonl"
assert_eq 1 "$(runner_call gigacode fanout_count "$run_dir")" 'Делегирование считается по уникальному JSON id'

finish_tests
