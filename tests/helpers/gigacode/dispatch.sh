#!/usr/bin/env bash
# Настоящие model resolver, dispatcher, launcher, registry и status consumer.
# Вторичный Codex выполняет синтетическую host-границу, его классификатор остаётся штатным.
set -uo pipefail
source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/multi-runner.sh"

_pf() { pipeline_store_file "$1"; }
get() { pipeline_store_get "$1" "$2"; }
set_st() { local task=$1; shift; run_state_control_update "$task" "$@"; }

PROFILE_NAME=fixture
mkdir -p "$FACTORY_PROFILES_DIR/fixture" "$FACTORY_RUNNERS_DIR"
ln -s "$FACTORY_HOME/lib/runners/gigacode.sh" "$FACTORY_RUNNERS_DIR/gigacode.sh"
cat >"$FACTORY_RUNNERS_DIR/codex.sh" <<'BASH'
source "$FACTORY_HOME/lib/runners/codex.sh"
runner_codex_probe() { printf '1.0.0\n'; }
runner_codex_catalog() {
  printf 'synthetic-peer\tcodex\tfixture\t1\tdefault\t1\t1\t0\t1\t0.0.0\t999.0.0\n'
}
runner_codex_run() {
  printf 'peer\n' >>"$GIGA_TEST_PEER_COUNT"
  "$FACTORY_HOME/lib/stage-result.sh" --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
    --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" done 'synthetic peer'
}
BASH
printf '%s\n' RUNNERS_SCHEMA=1 CONFIG_REVISION=1 \
  "PROJECT_RUNNER_PRIMARY=${GIGA_TEST_PRIMARY:-gigacode}" \
  "PROJECT_RUNNER_FAILOVER=${GIGA_TEST_SECONDARY:-codex}" \
  'MODEL_DEFAULT_GIGACODE_EXACT=synthetic/model-a(gigacode)' \
  MODEL_DEFAULT_CODEX_FAMILY=fixture >"$FACTORY_PROFILES_DIR/fixture/runners.env"
if [[ "${GIGA_TEST_NO_MODEL_POLICY:-}" == 1 ]]; then
  sed -i '/MODEL_DEFAULT_GIGACODE_EXACT=/d' "$FACTORY_PROFILES_DIR/fixture/runners.env"
fi
if [[ -n "${GIGA_TEST_EFFORT:-}" ]]; then
  printf 'MODEL_DEFAULT_GIGACODE_EFFORT=%s\n' "$GIGA_TEST_EFFORT" \
    >>"$FACTORY_PROFILES_DIR/fixture/runners.env"
fi
pipeline_store_route_init 42 CHECK || exit
factory_control_init synthetic-control-secret || exit
switch_pid=''
if [[ "${GIGA_TEST_SWITCH:-}" == 1 ]]; then
  (
    for _poll in {1..1000}; do
      active=$(run_state_active_file 42 CHECK)
      run_id=$(_run_state_get "$active" RUN_ID)
      epoch=$(_run_state_get "$active" EPOCH)
      events="$STATE_DIR/logs/runs/t42/CHECK/$run_id/events.jsonl"
      if [[ -n "$run_id" ]] && grep -q '"event":"prompt_started"' "$events" 2>/dev/null; then
        runtime_switch_request 42 CHECK "$run_id" "$epoch" codex synthetic-switch
        exit
      fi
      sleep 0.01
    done
    exit 1
  ) &
  switch_pid=$!
fi
multi_runner_run 42 'Synthetic dispatcher prompt' CHECK 10
rc=$?
[[ -z "$switch_pid" ]] || wait "$switch_pid"
printf 'DISPATCH_KIND=%s\nDISPATCH_RUNNER=%s\nDISPATCH_DETAIL=%s\nRUN_DIR=%s\n' \
  "${DISPATCH_RESULT_KIND:-}" "${DISPATCH_RESULT_RUNNER:-}" "${DISPATCH_RESULT_DETAIL:-}" \
  "${MULTI_LAST_RUN_ID:+$STATE_DIR/logs/runs/t42/CHECK/$MULTI_LAST_RUN_ID}"
exit "$rc"
