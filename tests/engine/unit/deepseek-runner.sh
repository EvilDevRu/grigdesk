#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

runner="$FACTORY_HOME/lib/runners/deepseek.sh"
if [[ ! -f "$runner" ]]; then
  test_fail "DeepSeek runner module exists" "missing $runner"
  finish_tests
  exit $?
fi

source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runners/catalog.sh"
runner_registry_reset
runner_registry_add deepseek "$runner"
assert_rc 0 "$?" "DeepSeek runner autoloads"
runner_contract_check deepseek
assert_rc 0 "$?" "DeepSeek runner satisfies the common contract"

unset GRIGDESK_DEEPSEEK_RUNTIME_HOME
export GRIGDESK_DEEPSEEK_BIN="$TEST_ROOT/missing-private-elf"
PATH="$TEST_ROOT/empty-bin" runner_call deepseek probe >/dev/null 2>&1
assert_rc 126 "$?" "offline guard блокирует metadata probe до внешнего executable"
export FACTORY_FORBID_LIVE=0
PATH="$TEST_ROOT/empty-bin" runner_call deepseek probe >/dev/null 2>&1
assert_rc 4 "$?" "probe reports a missing binary without falling through"

mkdir -p "$TEST_ROOT/bin"
probe_bin="$TEST_ROOT/bin/dsh"
printf '#!/usr/bin/env bash\nprintf "0.1.5-rc.2\\n"\n' >"$probe_bin"
chmod +x "$probe_bin"

export GRIGDESK_DEEPSEEK_BIN="$TEST_ROOT/missing-private-elf"
runtime_bin="$TEST_ROOT/runtime/install/current/node_modules/.bin/dsh"
path_bin="$TEST_ROOT/path-bin/dsh"
mkdir -p "$(dirname "$runtime_bin")" "$(dirname "$path_bin")"
printf '#!/usr/bin/env bash\nprintf "0.1.5-rc.2\\n"\n' >"$runtime_bin"
printf '#!/usr/bin/env bash\nprintf "9.9.9\\n"\n' >"$path_bin"
chmod +x "$runtime_bin" "$path_bin"
export GRIGDESK_DEEPSEEK_RUNTIME_HOME="$TEST_ROOT/runtime"
export FACTORY_FORBID_LIVE=0
version=$(PATH="$TEST_ROOT/path-bin:/usr/bin:/bin" runner_call deepseek probe)
assert_rc 4 "$?" "stock runtime-current и PATH dsh больше не выбираются"
assert_eq "" "$version" "без нашего binary metadata probe не выдаёт stock version"
export GRIGDESK_DEEPSEEK_BIN="$probe_bin"
unset GRIGDESK_DEEPSEEK_RUNTIME_HOME
export GRIGDESK_DEEPSEEK_BIN="$probe_bin" FACTORY_FORBID_LIVE=0
printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' \
  "$NODE_BIN" "$FACTORY_HOME/../tests/fixtures/deepseek-harness/fakeBinary.mts" >"$probe_bin"
version=$(runner_call deepseek probe)
assert_rc 0 "$?" "probe принимает совместимый binary metadata независимо от upstream pin"
assert_contains "$version" '9.2.0-grigdesk.' "probe сохраняет upstream и полную observed identity"
assert_contains "$version" ".p$(printf 'a%.0s' {1..64})" "coverage включает полный packageId"
printf '#!/usr/bin/env bash\nprintf "0.1.5-rc.2\\n"\n' >"$probe_bin"
chmod +x "$probe_bin"
runner_call deepseek probe >/dev/null 2>&1
assert_rc 4 "$?" "stock dsh без metadata отклоняется даже с прежним pinned номером"
printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' \
  "$NODE_BIN" "$FACTORY_HOME/../tests/fixtures/deepseek-harness/fakeBinary.mts" >"$probe_bin"
chmod +x "$probe_bin"

catalog=$(runner_call deepseek catalog)
assert_rc 0 "$?" "catalog is available without a model prompt"
model='["deepseek-official","deepseek-v4-flash"]'
line=$(printf '%s\n' "$catalog" | awk -F '\t' -v wanted="$model" '$1 == wanted { print; exit }')
assert_eq 11 "$(awk -F '\t' '{print NF}' <<<"$line")" "catalog rows use the 11-field models.tsv schema"
assert_eq deepseek "$(awk -F '\t' '{print $2}' <<<"$line")" "catalog row names the provider"
assert_eq default "$(awk -F '\t' '{print $3}' <<<"$line")" "opaque ACP ids do not invent a family"
assert_eq 4 "$(printf '%s\n' "$catalog" | sed '/^$/d' | wc -l)" \
  "catalog carries all four model ids observed in P0"
for opaque in \
  '["deepseek-official","deepseek-flash"]' \
  '["deepseek-official","deepseek-v4-flash"]' \
  '["deepseek-official","deepseek-v4-pro"]' \
  '["deepseek-official","deepseek-v4-flash-vision-exp"]'; do
  assert_contains "$catalog" "$opaque" "catalog preserves opaque id $opaque"
done

policy=$(runner_deepseek_default_policy)
assert_contains "$policy" 'FAMILY=default' "default policy resolves the metadata family"
assert_contains "$policy" 'EFFORT=high' "default policy pins the observed default effort"
runner_deepseek_family_alias default >/dev/null 2>&1
assert_rc 4 "$?" "catalog-backed runner does not invent family aliases"
assert_eq 'status status_request tools structured_output' \
  "$(runner_call deepseek capabilities)" "capabilities omit sandbox/fanout claims"

snapshot="$TEST_ROOT/catalog"
mkdir -p "$snapshot"
printf '%s\n' "$catalog" >"$snapshot/models.tsv"
resolved=$(catalog_resolve "$snapshot" deepseek default latest auto "$version")
assert_rc 0 "$?" "minimal policy resolves without MODEL_DEFAULT_DEEPSEEK overrides"
assert_eq "$model" "$resolved" "catalog resolver preserves the opaque model id"

events="$TEST_ROOT/events"
mkdir -p "$events"
printf '%s\n' \
  '{"event":"tool_call","name":"bash"}' \
  '{"event":"tool_call","name":"write"}' >"$events/events.jsonl"
assert_eq 0 "$(runner_call deepseek fanout_count "$events")" \
  "ordinary tool calls do not count as delegation"
printf '%s\n' '{"event":"tool_call","name":"subagent"}' >>"$events/events.jsonl"
assert_eq 1 "$(runner_call deepseek fanout_count "$events")" \
  "fanout count comes from named delegation tool calls, not a constant"

source "$FACTORY_HOME/lib/multi-runner.sh"
runner_registry_add deepseek "$runner"
declare -gA MULTI_PLAN_LEVEL=()
declare -gA MULTI_PLAN_DEGRADED=()
MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.deepseek-plan.XXXXXX")
FACTORY_ROUTE_FANOUT_MODE=parallel FACTORY_ROUTE_FANOUT_MAX=3 \
FACTORY_ROUTE_FANOUT_DEGRADE=forbid _multi_execution_plan deepseek >/dev/null 2>&1
assert_rc 1 "$?" "strict parallel fanout rejects DeepSeek before launch"
FACTORY_ROUTE_FANOUT_MODE=parallel FACTORY_ROUTE_FANOUT_MAX=3 \
FACTORY_ROUTE_FANOUT_DEGRADE=allow-single _multi_execution_plan deepseek
assert_rc 0 "$?" "allow-single explicitly degrades DeepSeek to one executor"
assert_eq degraded "${MULTI_PLAN_LEVEL[deepseek]}" \
  "fanout degradation is recorded instead of silently claimed native"
rm -rf -- "$MULTI_CATALOG_ROOT"

assert_contains "$(cat "$FACTORY_HOME/lib/core.sh")" 'RUNNER_DEEPSEEK_ADD_DIRS' \
  "core exports the DeepSeek prompt-context directories"

finish_tests
