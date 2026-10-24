#!/usr/bin/env bash
# Ранняя проверка читает курсор и удерживает только остановки, которым нужен goto.
# Остальные исходы human и терминальные остановки остаются на прежнем пути resume.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/route-runtime.sh"
export FACTORY_CONTROL_ROOT="$TEST_ROOT/control"
mkdir -p "$FACTORY_CONTROL_ROOT"

_route_v2_load_attempt() {
  return 0
}

attempt_stage_state_read_v2() {
  cat "$TEST_ROOT/cursor.json"
}

v2_log() {
  printf '%s\n' "$*" >>"$TEST_ROOT/stages.log"
}

# Подставлен только reader: настоящий parser курсора и сама проверка не заменяются.
# При пропуске остановки проверка обязана молчать и не менять прочитанный курсор.
check_cursor() {
  local state=$1 stop=$2 outcome=$3 expected=$4 before rc
  printf '{"state":"%s","stop":"%s","lastCommit":{"node":"review","outcome":"%s"}}\n' \
    "$state" "$stop" "$outcome" >"$TEST_ROOT/cursor.json"
  before=$(cat "$TEST_ROOT/cursor.json")
  : >"$TEST_ROOT/stages.log"
  route_v2_failed_stop_held 1 a_11111111111111111111111111111111
  rc=$?
  assert_rc "$expected" "$rc" "$state/$stop/$outcome: код ранней проверки"
  assert_eq "$before" "$(cat "$TEST_ROOT/cursor.json")" "$state/$stop/$outcome: курсор сохранён"
  if (( expected == 11 )); then
    assert_contains "$(cat "$TEST_ROOT/stages.log")" 'REVIEW: маршрут остановлен:' \
      "$stop: строка называет узел"
    assert_contains "$(cat "$TEST_ROOT/stages.log")" 'goto' "$stop: строка подсказывает возврат"
  else
    assert_eq '' "$(cat "$TEST_ROOT/stages.log")" "$state/$stop/$outcome: нет ложного отказа"
  fi
}

for outcome in done skipped failed exhausted approved rejected; do
  expected=0
  [[ "$outcome" != failed ]] || expected=11
  check_cursor stopped human "$outcome" "$expected"
done
check_cursor stopped rewind-limit failed 11
check_cursor stopped no-progress failed 11
check_cursor stopped loop-ceiling failed 0
check_cursor stopped failed failed 0
check_cursor stopped done done 0
check_cursor ready human failed 0
check_cursor paused human failed 0

printf '{}\n' >"$TEST_ROOT/cursor.json"
: >"$TEST_ROOT/stages.log"
route_v2_failed_stop_held 1 a_11111111111111111111111111111111
assert_rc 0 "$?" 'непрочитанный курсор проверит общий строгий путь'
assert_eq '' "$(cat "$TEST_ROOT/stages.log")" 'повреждённый курсор не выдаётся за остановку failed'

finish_tests
