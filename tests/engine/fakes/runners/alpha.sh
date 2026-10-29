#!/usr/bin/env bash

runner_alpha_probe() {
  [[ "${FAKE_ALPHA_PROBE:-ready}" == ready ]] || return 4
  printf 'ready\n'
}

runner_alpha_catalog() {
  printf 'alpha-model\talpha\tfixture\t1\tdefault\t1\t1\t0\t1\t0.0.0\t999.0.0\n'
}

runner_alpha_capabilities() {
  printf 'status status_fd foreground structured_output fanout\n'
}

runner_alpha_run() {
  local _task=$1 prompt=$2 _stage=$3
  printf 'alpha\n' >>"${TEST_ROOT:?}/invocations"
  if [[ -n "${FAKE_ALPHA_PROMPT_FILE:-}" ]]; then
    printf '%s\n' "$prompt" >"$FAKE_ALPHA_PROMPT_FILE"
  fi
  case "${FAKE_ALPHA_RESULT:-limited}" in
    done|review-alternative)
      if [[ "${FAKE_ALPHA_RESULT:-}" == review-alternative ]]; then
        printf '%s\n' \
          '{"type":"item.completed","item":{"type":"command_execution","exit_code":1,"aggregated_output":"Тестовый отказ reviewer: denied"}}'
        printf 'разрешённая альтернатива\n' >"$TEST_ROOT/alternative-effect"
      fi
      FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" \
        --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
        --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" done
      ;;
    failed)
      FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" \
        --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
        --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" failed
      ;;
    human)
      FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" \
        --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
        --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" \
        --failure-owner human --finding 'review-denied=Тестовый отказ reviewer' failed
      ;;
    no-status) return 0 ;;
    wait)
      trap 'exit 143' TERM
      while true; do sleep 1; done
      ;;
    denied) return 41 ;;
    timeout) return 124 ;;
    limited) return 42 ;;
    *) return 41 ;;
  esac
}

runner_alpha_classify() {
  local _run_dir=$1 rc=$2
  case "${FAKE_ALPHA_RESULT:-limited}:$rc" in
    done:0|failed:0|human:0|review-alternative:0|no-status:0) printf 'ok\n' ;;
    limited:42) printf 'limited\n' ;;
    denied:41) printf 'denied\n' ;;
    timeout:124) printf 'timeout\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

runner_alpha_fanout_count() { printf '0\n'; }
runner_alpha_dialect() { printf 'fixture alpha dialect\n'; }
runner_alpha_interrupt() { return 0; }
