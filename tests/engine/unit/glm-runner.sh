#!/usr/bin/env bash
# Контракт GLM-раннера этапа: metadata без ключа модели, каталог маршрута zai,
# политика по умолчанию, capabilities и выбор модели общим dispatcher-ом.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

runner="$FACTORY_HOME/lib/runners/glm.sh"
if [[ ! -f "$runner" ]]; then
  test_fail "GLM runner module exists" "missing $runner"
  finish_tests
  exit $?
fi

source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runners/catalog.sh"
runner_registry_reset
runner_registry_add glm "$runner"
assert_rc 0 "$?" "GLM runner регистрируется явно"
runner_contract_check glm
assert_rc 0 "$?" "GLM runner проходит общий контракт"

package_a=$(printf 'a%.0s' {1..64})
package_b=$(printf 'b%.0s' {1..64})
mkdir -p "$TEST_ROOT/bin"
fake_bin="$TEST_ROOT/bin/dsh-glm"
printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' \
  "$NODE_BIN" "$FACTORY_HOME/../tests/fixtures/deepseek-harness/fakeGlmBinary.mts" >"$fake_bin"
chmod +x "$fake_bin"
export GRIGDESK_DEEPSEEK_BIN="$fake_bin"
export GRIGDESK_DEEPSEEK_CACHE_DIR="$TEST_ROOT/dsh-cache"
export GRIGDESK_GLM_API_MODE=api
unset ZAI_API_KEY ZAI_CODING_API_KEY
replaced_bin="$TEST_ROOT/bin/dsh-glm-replaced"
printf '#!/usr/bin/env bash\nexec "%s" "%s" --fixture-package-id "%s" "$@"\n' \
  "$NODE_BIN" "$FACTORY_HOME/../tests/fixtures/deepseek-harness/fakeGlmBinary.mts" "$package_b" \
  >"$replaced_bin"
chmod +x "$replaced_bin"

runner_call glm probe >/dev/null 2>&1
assert_rc 126 "$?" "offline guard блокирует metadata probe GLM до внешнего executable"
export FACTORY_FORBID_LIVE=0

version=$(runner_call glm probe)
assert_rc 0 "$?" "probe Обычного API проходит без ключа модели"
assert_contains "$version" '9.2.0-grigdesk.' "probe сохраняет upstream и observed identity"
assert_contains "$version" ".p$package_a." "версия раннера различает packageId DSH"
assert_contains "$version" '.grigdesk-glm-factory-profile-v2.grigdesk-glm-factory-policy-v3' \
  "версия раннера включает ревизии профиля и политики этапа"

# Coding Plan допущен с factory-policy-v2 (29.10.2026): probe проходит тем же фикстурным DSH.
GRIGDESK_GLM_API_MODE=coding-plan version_cp=$(runner_call glm probe)
assert_rc 0 "$?" "probe Coding Plan проходит без ключа модели"
assert_contains "$version_cp" '.grigdesk-glm-factory-policy-v3' \
  "probe Coding Plan отдаёт ту же ревизию политики"
GRIGDESK_GLM_API_MODE='' runner_call glm probe >/dev/null 2>&1
assert_rc 4 "$?" "без режима доступа этап GLM недоступен"
GRIGDESK_GLM_API_MODE=team-plan runner_call glm probe >/dev/null 2>&1
assert_rc 4 "$?" "неизвестный режим доступа этап GLM не допускает"
GRIGDESK_DEEPSEEK_BIN="$TEST_ROOT/missing-elf" runner_call glm probe >/dev/null 2>&1
assert_rc 4 "$?" "отсутствующий DSH ELF даёт штатный код недоступности"

catalog=$(runner_call glm catalog)
assert_rc 0 "$?" "catalog доступен без ключа и запуска модели"
model='["zai","glm-5.3"]'
line=$(printf '%s\n' "$catalog" | awk -F '\t' -v wanted="$model" '$1 == wanted { print; exit }')
assert_eq 11 "$(awk -F '\t' '{print NF}' <<<"$line")" "строки каталога используют схему models.tsv"
assert_eq glm "$(awk -F '\t' '{print $2}' <<<"$line")" "строка каталога называет провайдера glm"
assert_eq default "$(awk -F '\t' '{print $3}' <<<"$line")" "непрозрачный id не придумывает семейство"
assert_eq 7 "$(printf '%s\n' "$catalog" | sed '/^$/d' | wc -l)" \
  "каталог содержит семь проверенных моделей маршрута zai"
if grep -q 'deepseek-official' <<<"$catalog"; then
  test_fail "каталог GLM не заимствует модели DeepSeek" "$catalog"
else
  test_ok "каталог GLM не заимствует модели DeepSeek"
fi

policy=$(runner_glm_default_policy)
assert_contains "$policy" 'FAMILY=default' "политика по умолчанию выбирает семейство каталога"
assert_contains "$policy" 'EFFORT=high' "политика по умолчанию закрепляет уровень high"
runner_glm_family_alias default >/dev/null 2>&1
assert_rc 4 "$?" "раннер с каталогом не придумывает алиасы семейств"
assert_eq 'status status_request tools structured_output' \
  "$(runner_call glm capabilities)" "capabilities не заявляют sandbox, fanout и native resume"

snapshot="$TEST_ROOT/catalog"
mkdir -p "$snapshot"
printf '%s\n' "$catalog" >"$snapshot/models.tsv"
resolved=$(catalog_resolve "$snapshot" glm default latest auto "$version")
assert_rc 0 "$?" "минимальная политика разрешается без MODEL_DEFAULT_GLM"
assert_eq "$model" "$resolved" "resolver выбирает первую модель каталога как есть"

# Общий dispatcher: профиль без модельной карты GLM получает default high из адаптера.
source "$FACTORY_HOME/lib/multi-runner.sh"
runner_registry_add glm "$runner"
assert_eq "$version" "$(_multi_probe_version "$version")" \
  "semver-parser движка сохраняет полную версию раннера"
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture"
PROFILE_NAME=fixture
printf '%s\n' RUNNERS_SCHEMA=1 CONFIG_REVISION=1 \
  PROJECT_RUNNER_PRIMARY=glm PROJECT_RUNNER_FAILOVER= >"$FACTORY_PROFILES_DIR/fixture/runners.env"
MULTI_STAGE=BUILD
declare -gA MULTI_PROBE_READY=()
declare -gA MULTI_PROBE_VERSION=()
declare -gA MULTI_PLAN_LEVEL=()
declare -gA MULTI_PLAN_DEGRADED=()
MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.glm-resolve.XXXXXX")
_multi_resolve glm ""
assert_rc 0 "$?" "dispatcher разрешает GLM без модельной карты профиля"
assert_eq "$model" "$DISPATCH_RESOLVED_MODEL" "dispatcher получает модель из каталога GLM"
assert_eq high "$DISPATCH_RESOLVED_EFFORT" "dispatcher применяет default high адаптера"
assert_eq "$version" "$DISPATCH_RUNNER_VERSION" "dispatcher закрепляет наблюдённую версию раннера"
_multi_catalog_cleanup

# Замена ELF после прежней пробы: устаревшее покрытие не продолжает работу на новой поставке.
MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.glm-resolve.XXXXXX")
GRIGDESK_DEEPSEEK_BIN=$replaced_bin _multi_resolve glm "" 2>"$TEST_ROOT/stale.err"
assert_rc 4 "$?" "сменившийся packageId DSH не разрешается прежним покрытием"
assert_eq runtime_changed "$DISPATCH_RESOLVE_RESULT" "смена поставки — runtime_changed, не fallback"
assert_contains "$(cat "$TEST_ROOT/stale.err")" 'FACTORY_ERROR=runtime_changed RUNNERS=glm' \
  "отказ смены поставки виден движку типизированным маркером"
_multi_catalog_cleanup

MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.glm-plan.XXXXXX")
FACTORY_ROUTE_FANOUT_MODE=parallel FACTORY_ROUTE_FANOUT_MAX=3 \
FACTORY_ROUTE_FANOUT_DEGRADE=forbid _multi_execution_plan glm >/dev/null 2>&1
assert_rc 1 "$?" "строгий parallel fanout отвергает GLM до запуска"
assert_eq unavailable "${MULTI_PLAN_LEVEL[glm]}" "требование fanout делает GLM unavailable"
FACTORY_ROUTE_FANOUT_MODE=parallel FACTORY_ROUTE_FANOUT_MAX=3 \
FACTORY_ROUTE_FANOUT_DEGRADE=allow-single _multi_execution_plan glm
assert_rc 0 "$?" "allow-single явно сводит GLM к одному исполнителю"
assert_eq degraded "${MULTI_PLAN_LEVEL[glm]}" "деградация fanout записана, а не выдана за native"
rm -rf -- "$MULTI_CATALOG_ROOT"

source "$FACTORY_HOME/lib/runner-launcher.sh"
assert_eq glm-jsonl-unknown "$(_runner_runtime_usage_dialect glm "$version")" \
  "поток GLM намеренно не зарегистрирован для billing usage"
assert_contains "$(cat "$FACTORY_HOME/lib/core.sh")" 'RUNNER_GLM_ADD_DIRS' \
  "ядро экспортирует prompt-контекст каталогов GLM"

finish_tests
