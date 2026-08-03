#!/usr/bin/env bash

runner_beta_probe() {
  [[ "${FAKE_BETA_PROBE:-ready}" == ready ]] || return 4
  printf 'ready\n'
}

runner_beta_catalog() {
  printf 'beta-model\tbeta\tfixture\t1\tdefault\t1\t1\t0\t1\t0.0.0\t999.0.0\n'
}

runner_beta_capabilities() {
  printf 'status status_fd foreground structured_output\n'
}

runner_beta_run() {
  printf 'beta\n' >>"${TEST_ROOT:?}/invocations"
  printf '%s\n' "$2" >"$TEST_ROOT/beta.prompt"
  if [[ "${FAKE_BETA_CAPTURE_ACTIVE_REASON:-0}" == 1 ]]; then
    awk -F= -v key="RUNNER_REASON_${FACTORY_RUN_STAGE}" \
      '$1 == key { value=$2 } END { print value }' \
      "$STATE_DIR/t${FACTORY_RUN_TASK}.pipeline" >"$TEST_ROOT/beta.active-reason"
  fi
  FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" \
    --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
    --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" done
}

runner_beta_classify() {
  [[ "$2" == 0 ]] && printf 'ok\n' || printf 'unknown\n'
}

runner_beta_fanout_count() { printf '0\n'; }
runner_beta_dialect() { printf 'fixture beta dialect\n'; }
runner_beta_interrupt() { return 0; }
