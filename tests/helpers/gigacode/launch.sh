#!/usr/bin/env bash
# Служебный host launcher настоящий; синтетический только внешний GigaCode CLI.
# Guard снимается родительским тестом после проверки realpath всех зависимостей.
set -uo pipefail
source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"
source "$FACTORY_HOME/lib/multi-runner.sh"

pipeline_store_route_init 42 CHECK || exit
factory_control_init synthetic-control-secret || exit
run_state_begin 42 CHECK synthetic-run 1 synthetic-status-secret || exit
runner_registry_reset
runner_registry_add gigacode "$FACTORY_HOME/lib/runners/gigacode.sh" || exit

if [[ "${GIGA_TEST_PLAN:-}" == 1 ]]; then
  MULTI_CATALOG_ROOT=$(mktemp -d "$STATE_DIR/.catalog-invoke.XXXXXX")
  declare -gA MULTI_PLAN_LEVEL=()
  declare -gA MULTI_PLAN_DEGRADED=()
  _multi_execution_plan gigacode
  plan_rc=$?
  printf 'PLAN_LEVEL=%s\nPLAN_DEGRADED=%s\n' \
    "${MULTI_PLAN_LEVEL[gigacode]}" "${MULTI_PLAN_DEGRADED[gigacode]}"
  _multi_catalog_cleanup
  [[ "$plan_rc" == 0 ]] || exit 79
fi

run_dir="$STATE_DIR/logs/runs/t42/CHECK/synthetic-run"
runner_launch gigacode 42 'Синтетический prompt; $(данные)' CHECK \
  'synthetic/model-a(gigacode)' "${GIGA_TEST_EFFORT:-}" "${GIGA_TEST_TIMEOUT:-10}" \
  "$run_dir" synthetic-run 1 synthetic-status-secret
rc=$?
printf 'LAUNCH_RC=%s\nRESULT=%s\nCOMMENT=%s\n' "$rc" \
  "$(pipeline_store_get 42 CHECK)" "$(pipeline_store_get 42 CHECK_COMMENT)"
printf 'VERDICT_B64=%s\nPLANS=%s\nROUTE_BY=%s\nUNTRUSTED=%s\n' \
  "$(_run_state_get "$(run_state_active_file 42 CHECK)" VERDICT_B64)" \
  "$(pipeline_store_get 42 PLANS)" "$(pipeline_store_get 42 ROUTE_BY)" \
  "$(pipeline_store_get 42 UNTRUSTED)"
printf 'FANOUT=%s\n' "$(runner_call gigacode fanout_count "$run_dir")"
exit "$rc"
