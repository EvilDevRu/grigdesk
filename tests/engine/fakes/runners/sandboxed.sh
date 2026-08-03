#!/usr/bin/env bash

runner_sandboxed_probe() { printf 'ready\n'; }
runner_sandboxed_catalog() {
  printf 'sandboxed-model\tsandboxed\tfixture\t1\tdefault\t1\t1\t0\t1\t0.0.0\t999.0.0\n'
}
runner_sandboxed_capabilities() { printf 'status status_request foreground structured_output\n'; }

runner_sandboxed_run() {
  local _task=$1 prompt=$2 _stage=$3 _model=$4 _effort=$5 _timeout=$6 run_dir=$7
  # Codex запускает tool-команды в отдельном PID namespace и закрывает inherited FD.
  exec 7<&-
  FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-progress.sh" \
    --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
    --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" REVIEW_BE running
  [[ "$?" == 2 ]] || return 71
  FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-progress.sh" \
    --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
    --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" PLANS done || return
  local visible=0
  for _poll in {1..20}; do
    if grep -q '^PLANS=done$' "$STATE_DIR/t${FACTORY_RUN_TASK}.pipeline" 2>/dev/null; then
      visible=1
      break
    fi
    sleep 0.05
  done
  [[ "$visible" == 1 ]] || return 70
  printf 'visible\n' >"$run_dir/progress-visible"
  # Даже если отдельный progress-request оказался повреждён и был убран, принятый
  # позднее terminal result остаётся источником истины и не должен превращаться в stall.
  local corrupt="$FACTORY_STATUS_REQUEST_DIR/000-corrupt.request"
  printf 'SCHEMA=1\nTYPE=corrupt\nTASK=%s\nSTAGE=%s\nRUN_ID=%s\nEPOCH=%s\n' \
    "$FACTORY_RUN_TASK" "$FACTORY_RUN_STAGE" "$FACTORY_RUN_ID" "$FACTORY_RUN_EPOCH" >"$corrupt"
  sleep 0.2
  rm -f -- "$corrupt"
  FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" \
    --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
    --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" done "sandbox completed" || return
  printf 'sandboxed result for %s\n' "$prompt" >"$run_dir/last.md"
}

runner_sandboxed_classify() {
  [[ "$2" == 0 ]] && printf 'ok\n' || printf 'unknown\n'
}
runner_sandboxed_fanout_count() { printf '0\n'; }
runner_sandboxed_dialect() { printf 'sandboxed fixture\n'; }
runner_sandboxed_interrupt() { return 0; }
