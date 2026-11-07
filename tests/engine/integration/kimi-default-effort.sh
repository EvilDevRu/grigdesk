#!/usr/bin/env bash
# Настоящие resolver, dispatcher и launcher используют default policy Kimi без EFFORT.
# Только внешний run заменён локальной записью полученного усилия и сдачей статуса.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/multi-runner.sh"

_pf() { pipeline_store_file "$1"; }
get() { pipeline_store_get "$1" "$2"; }
set_st() { local task=$1; shift; run_state_control_update "$task" "$@"; }

PROFILE_NAME=fixture
export FACTORY_RUNNERS_DIR="$TEST_ROOT/runners"
export KIMI_TEST_EFFORT_FILE="$TEST_ROOT/kimi-effort"
mkdir -p "$FACTORY_RUNNERS_DIR" "$FACTORY_PROFILES_DIR/$PROFILE_NAME"
cat >"$FACTORY_RUNNERS_DIR/kimi.sh" <<'BASH'
source "$FACTORY_HOME/lib/runners/kimi.sh"
runner_kimi_probe() { printf '0.31.1\n'; }
runner_kimi_run() {
  printf '%s' "$5" >"$KIMI_TEST_EFFORT_FILE"
  "$FACTORY_HOME/lib/stage-result.sh" --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
    --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" done 'synthetic Kimi'
}
BASH
printf '%s\n' RUNNERS_SCHEMA=1 CONFIG_REVISION=1 PROJECT_RUNNER_PRIMARY=kimi \
  PROJECT_RUNNER_FAILOVER= >"$FACTORY_PROFILES_DIR/$PROFILE_NAME/runners.env"

pipeline_store_route_init 42 CHECK
assert_rc 0 "$?" 'Создан изолированный маршрут Kimi'
factory_control_init synthetic-kimi-control
assert_rc 0 "$?" 'Создан host status control'
multi_runner_run 42 'synthetic Kimi default effort' CHECK 10
assert_rc 0 "$?" 'Kimi без FAMILY/EXACT/EFFORT проходит настоящую цепь запуска'
assert_eq kimi "$DISPATCH_RESULT_RUNNER" 'Запущен именно Kimi'
assert_eq high "$(cat "$KIMI_TEST_EFFORT_FILE")" 'Runner без default_effort hook получает прежний high'

finish_tests
