#!/usr/bin/env bash
# Resume остановленного курсора не заменяет goto с новой гипотезой.
# Настоящий launcher проверяется вместе с реестром и обоими trusted-журналами.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_TESTS_HOME/fixtures/route-loop-launcher.sh"

export FACTORY_CONTROL_ROOT="$control"
export FACTORY_ROUTE_STATE_DIR="$state"
source "$FACTORY_HOME/lib/route-runtime.sh"
write_profile 2

# Читаем проверенные события целиком: совпадение только числа human-событий
# пропустило бы лишнюю сессию, provisioning или cleanup после пустого resume.
ledger_snapshot() {
  attempt_lifecycle_read_v2 "$task" "$attempt" || return
  attempt_stage_state_read_v2 "$task" "$attempt"
}

# Каждый сценарий сначала получает настоящую остановку из dispatcher.
# После проверки пустого resume явный goto обязан снова запустить тот же узел.
check_held_stop() {
  local expected_stop=$1 route=$2 before resume_rc
  : >"$LOOP_CALLS"
  launch "$TEST_ROOT/start-$expected_stop.log" start --profile demo-profile --route "$route" \
    --ticket-json "$TEST_ROOT/ticket.json"
  assert_rc 0 "$?" "$expected_stop: start создал остановку"
  attempt=$(registry_value ATTEMPT_ID)
  cursor=$(attempt_stage_state_read_v2 "$task" "$attempt")
  assert_eq stopped "$(jq -r .state <<<"$cursor")" "$expected_stop: курсор остановлен"
  assert_eq "$expected_stop" "$(jq -r .stop <<<"$cursor")" "$expected_stop: причина подтверждена"
  assert_eq failed "$(jq -r .lastCommit.outcome <<<"$cursor")" "$expected_stop: исход failed"
  before=$(ledger_snapshot | sha256sum)
  : >"$LOOP_CALLS"
  launch "$TEST_ROOT/resume-$expected_stop.log" resume --profile demo-profile --attempt "$attempt"
  resume_rc=$?
  test_note "$expected_stop: resume rc=$resume_rc"
  assert_rc 0 "$resume_rc" "$expected_stop: resume завершается штатно"
  assert_eq "$before" "$(ledger_snapshot | sha256sum)" "$expected_stop: trusted-журналы не меняются"
  assert_eq 1 "$(registry_value STALLED_HUMAN)" "$expected_stop: ожидание человека сохранено"
  assert_eq "stopped-$expected_stop" "$(registry_value RESULT)" "$expected_stop: RESULT сохранён"
  assert_eq '' "$(cat "$LOOP_CALLS")" "$expected_stop: исполнитель не запускался"
  assert_contains "$(tail -n 1 "$state/logs/t${task}.stages.log")" \
    'REVIEW: маршрут остановлен:' "$expected_stop: строка называет узел"
  assert_contains "$(tail -n 1 "$state/logs/t${task}.stages.log")" \
    'goto' "$expected_stop: журнал подсказывает возврат"

  launch "$TEST_ROOT/goto-$expected_stop.log" goto --profile demo-profile --attempt "$attempt" \
    --node review --reason 'Проверь исправленную причину отказа'
  assert_rc 0 "$?" "$expected_stop: goto на тот же узел принят"
  printf '%s\n' 'REVIEW|done|||' >"$LOOP_SCRIPT"
  launch "$TEST_ROOT/after-goto-$expected_stop.log" resume --profile demo-profile --attempt "$attempt"
  assert_rc 0 "$?" "$expected_stop: resume после goto работает"
  assert_eq waiting "$(registry_value GATE_ACCEPT)" "$expected_stop: узел дошёл до приёмки"
  assert_contains "$(cat "$LOOP_CALLS")" 'REVIEW:' "$expected_stop: узел действительно исполнен"
  launch "$TEST_ROOT/abandon-$expected_stop.log" abandon --profile demo-profile --attempt "$attempt" \
    --reason 'Проверка закончена'
  assert_rc 0 "$?" "$expected_stop: тестовая попытка закрыта"
}

printf '%s\n' 'REVIEW|failed|environment|env=Нужна новая гипотеза|' >"$LOOP_SCRIPT"
check_held_stop human loop

task=$((task + 1))
cat >"$LOOP_SCRIPT" <<'TXT'
REVIEW|failed|||
BUILD|done|||
REVIEW|failed|||
BUILD|done|||
REVIEW|failed|||
TXT
sed "s/7101/$task/g" "$TEST_ROOT/ticket.json" >"$TEST_ROOT/next-ticket.json"
mv "$TEST_ROOT/next-ticket.json" "$TEST_ROOT/ticket.json"
check_held_stop rewind-limit plain

previous_task=$task
task=$((task + 1))
cat >"$LOOP_SCRIPT" <<'TXT'
REVIEW|failed|build|same=Не снято прежнее замечание|
BUILD|done|||
REVIEW|failed|build|same=Не снято прежнее замечание|
BUILD|done|||
REVIEW|failed|build|same=Не снято прежнее замечание|
TXT
sed "s/$previous_task/$task/g" "$TEST_ROOT/ticket.json" >"$TEST_ROOT/next-ticket.json"
mv "$TEST_ROOT/next-ticket.json" "$TEST_ROOT/ticket.json"
check_held_stop no-progress plain

# Исчерпание бюджета остаётся разрешённым resume: движок сам пишет human-rewind,
# затем исполняет узел без отдельного решения goto.
previous_task=$task
task=$((task + 1))
sed "s/$previous_task/$task/g" "$TEST_ROOT/ticket.json" >"$TEST_ROOT/next-ticket.json"
mv "$TEST_ROOT/next-ticket.json" "$TEST_ROOT/ticket.json"
printf '%s\n' 'REVIEW|noresult|||' >"$LOOP_SCRIPT"
launch "$TEST_ROOT/exhausted-start.log" start --profile demo-profile --route loop \
  --ticket-json "$TEST_ROOT/ticket.json"
assert_rc 0 "$?" 'exhausted: start дошёл до остановки'
attempt=$(registry_value ATTEMPT_ID)
cursor=$(attempt_stage_state_read_v2 "$task" "$attempt")
assert_eq exhausted "$(jq -r .lastCommit.outcome <<<"$cursor")" 'exhausted: исход подтверждён'
printf '%s\n' 'REVIEW|done|||' >"$LOOP_SCRIPT"
launch "$TEST_ROOT/exhausted-resume.log" resume --profile demo-profile --attempt "$attempt"
assert_rc 0 "$?" 'exhausted: resume сам возвращает и исполняет узел'
assert_eq waiting "$(registry_value GATE_ACCEPT)" 'exhausted: продолжение дошло до приёмки'
assert_contains "$(find "$(attempt_state_v2_task_root "$task")/attempts/$attempt/stage-results" \
  -name 'event.*.json' -exec cat {} +)" 'продолжение после исчерпанного бюджета повторов' \
  'exhausted: автоматический human-rewind записан в журнал'

finish_tests
