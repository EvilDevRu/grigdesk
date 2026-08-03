#!/usr/bin/env bash

runner_fake_probe() {
  printf 'ready\n'
}

runner_fake_catalog() {
  printf 'fake-model\tfake\tfixture\t1\tdefault\t1\t1\t0\t1\t0.0.0\t999.0.0\n'
}

runner_fake_capabilities() {
  printf 'status status_fd foreground structured_output\n'
}

runner_fake_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  local status_token="" status_fd=${FACTORY_STATUS_FD:-7}
  if read -r status_token <&"$status_fd"; then
    printf '{"event":"status_fd","ok":true}\n'
  else
    printf '{"event":"status_fd","ok":false}\n'
  fi
  printf '{"event":"fake.completed","task":"%s","stage":"%s","model":"%s","effort":"%s"}\n' \
    "$task" "$stage" "$model" "$effort"
  printf 'fake result for %s\n' "$prompt" >"$run_dir/last.md"
  return "${FAKE_RUNNER_RC:-0}"
}

runner_fake_classify() {
  local run_dir=$1 rc=$2
  [[ "$rc" == 0 ]] && printf 'ok\n' || printf 'unknown\n'
}

runner_fake_fanout_count() {
  printf '0\n'
}

runner_fake_dialect() {
  printf 'fake dialect\n'
}

runner_fake_interrupt() {
  return 0
}
