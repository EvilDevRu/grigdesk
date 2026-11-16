#!/usr/bin/env bash
# Создание без старта: --hold-start создаёт попытку, контракты и стенд, но не
# диспетчеризует ни одного узла. Человек назначает исполнителя через runner set
# и стартует прогон обычным resume — курсор создаётся на resume, метка HELD_START
# снимается тем же заходом. Маршруты фикстуры объявляют bootstrap skip, поэтому
# отсутствие вызовов исполнителя проверяет и разведку, и основные узлы.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_TESTS_HOME/fixtures/route-loop-launcher.sh"

export FACTORY_CONTROL_ROOT="$control"
export FACTORY_ROUTE_STATE_DIR="$state"
source "$FACTORY_HOME/lib/route-runtime.sh"
write_profile 2

printf '%s\n' 'REVIEW|done|||' >"$LOOP_SCRIPT"
launch "$TEST_ROOT/held-start.log" start --profile demo-profile --route plain \
  --ticket-json "$TEST_ROOT/ticket.json" --hold-start
assert_rc 0 "$?" 'hold: start --hold-start завершился штатно'
attempt=$(registry_value ATTEMPT_ID)
assert_contains "$attempt" 'a_' 'hold: попытка создана'
assert_eq 1 "$(registry_value HELD_START)" 'hold: метка создания без старта в реестре'
assert_eq '' "$(registry_value ORCH_PID)" 'hold: демон завершился, PID очищен'
assert_eq 0 "$(registry_value STALLED_HUMAN)" 'hold: ожидания человека нет'
assert_eq 0 "$(registry_value STOPPED_SIGNAL)" 'hold: это не остановка по сигналу'
assert_eq '' "$(cat "$LOOP_CALLS" 2>/dev/null)" 'hold: ни один исполнитель не запускался'
assert_file_missing "$(attempt_state_v2_task_root "$task")/attempts/$attempt/artifacts/bootstrap.json" \
  'hold: артефакт разведки не создан'
attempt_stage_state_read_v2 "$task" "$attempt" >/dev/null 2>&1
assert_rc 73 "$?" 'hold: курсор не инициализирован'

# Флаг принадлежит только start: resume ведёт уже созданную попытку.
launch "$TEST_ROOT/held-bad-flag.log" resume --profile demo-profile --attempt "$attempt" --hold-start
assert_rc 78 "$?" 'hold: флаг вне start отклонён'
assert_contains "$(cat "$TEST_ROOT/held-bad-flag.log")" '--hold-start допустим только при start' \
  'hold: отказ называет причину'

# Назначение исполнителя на узел до старта: движку достаточно реестра, демон не нужен.
"$FACTORY_HOME/bin/factory" "$task" runner set REVIEW alpha >"$TEST_ROOT/held-override.log" 2>&1
assert_rc 0 "$?" 'hold: runner set принят без живого демона'
assert_eq alpha "$(registry_value RUNNER_OVERRIDE_STAGE_REVIEW)" \
  'hold: поузловое назначение записано в реестр'

launch "$TEST_ROOT/held-resume.log" resume --profile demo-profile --attempt "$attempt"
assert_rc 0 "$?" 'hold: resume стартовал созданный конвейер'
assert_eq 0 "$(registry_value HELD_START)" 'hold: метка снята следующим заходом движка'
assert_contains "$(cat "$LOOP_CALLS")" 'REVIEW:' 'hold: узел исполнен после ручного старта'
assert_eq waiting "$(registry_value GATE_ACCEPT)" 'hold: маршрут дошёл до приёмки'
attempt_stage_state_read_v2 "$task" "$attempt" >/dev/null 2>&1
assert_rc 0 "$?" 'hold: курсор создан на resume'

launch "$TEST_ROOT/held-abandon.log" abandon --profile demo-profile --attempt "$attempt" \
  --reason 'Проверка закончена'
assert_rc 0 "$?" 'hold: тестовая попытка закрыта'

finish_tests
