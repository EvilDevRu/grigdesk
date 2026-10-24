#!/usr/bin/env bash
# Отсутствие визита остаётся ошибкой контракта lifecycle, но причина должна быть видна.
# Проверка не создаёт событий: без визита связывать вмешательство человека не с чем.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runtime-analytics.sh"

v2_log() {
  printf '%s\n' "$*" >>"$TEST_ROOT/stages.log"
}

export FACTORY_LIFECYCLE_TASK_ID=t1
export FACTORY_LIFECYCLE_ATTEMPT_ID=a_11111111111111111111111111111111
export FACTORY_LIFECYCLE_PROFILE=fixture
export FACTORY_LIFECYCLE_SESSION_ID=os_11111111111111111111111111111111
unset FACTORY_LIFECYCLE_NODE_VISIT_ID
: >"$TEST_ROOT/stages.log"

runtime_lifecycle_human_begin_v2 manual_resume_required >/dev/null
assert_rc 78 "$?" 'без визита сохраняется отказ lifecycle'
assert_contains "$(cat "$TEST_ROOT/stages.log")" 'нет визита узла' \
  'отказ пишет причину в журнал этапов'

unset FACTORY_LIFECYCLE_SESSION_ID
: >"$TEST_ROOT/stages.log"
runtime_lifecycle_human_begin_v2 manual_resume_required >/dev/null
assert_rc 0 "$?" 'выключенный lifecycle остаётся допустимым'
assert_eq '' "$(cat "$TEST_ROOT/stages.log")" 'выключенный lifecycle не пишет ложную ошибку'

finish_tests
