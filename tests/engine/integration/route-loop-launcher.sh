#!/usr/bin/env bash
# Режим «цикл» через настоящий launcher: `factory start` и `factory resume`, реальный
# typed context, реестр, журнал стадий и продолжение после поднятого потолка кругов.
# Поддельный только исполнитель модели — он сдаёт вердикты по сценарию.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_TESTS_HOME/fixtures/route-loop-launcher.sh"

# --- start: два круга, третья передача упирается в потолок 2 -----------------------
write_profile 2
: >"$LOOP_CALLS"
cat >"$LOOP_SCRIPT" <<'TXT'
REVIEW|failed|build|s1=Этап один|
BUILD|done|||
REVIEW|failed|build|s2=Этап два|s1
BUILD|done|||
REVIEW|failed|build|s3=Этап три|s2
TXT
FACTORY_FORBID_LIVE=0 timeout -k 5 180 "$FACTORY_HOME/bin/factory" "$task" start \
  --profile demo-profile --route loop --ticket-json "$TEST_ROOT/ticket.json" \
  --routes-dir "$routes" \
  --state-dir "$state" --control-dir "$control" >"$TEST_ROOT/start.log" 2>&1
start_rc=$?
assert_rc 0 "$start_rc" "start доводит цикл до остановки по потолку"
if (( start_rc != 0 )); then
  tail -20 "$TEST_ROOT/start.log"
fi
assert_eq '' "$(cat "$LOOP_SCRIPT")" "сценарий старта пройден целиком"
assert_eq "$(printf '%s\n' \
  'REVIEW:lead:lead:t7101.report.r0.md' \
  'BUILD:worker:worker:t7101.report.r1.md' \
  'REVIEW:lead:lead:t7101.report.r1.md' \
  'BUILD:worker:worker:t7101.report.r2.md' \
  'REVIEW:lead:lead:t7101.report.r2.md')" "$(cat "$LOOP_CALLS")" \
  "роль, evidence.loop и отчёт круга доходят до каждого захода"
assert_eq 1 "$(registry_value LOOP_MODE)" "реестр знает режим цикла"
assert_eq 2 "$(registry_value LOOP_MAX_ROUNDS)" "реестр показывает потолок профиля"
assert_eq 2 "$(registry_value LOOP_ROUND)" "реестр показывает исполненные круги"
assert_eq 2 "$(registry_value LOOP_STAGE)" "реестр показывает этап"
assert_eq stopped-loop-ceiling "$(registry_value RESULT)" "остановка по потолку видна в реестре"
assert_contains "$(cat "$state/logs/t${task}.stages.log")" \
  'REVIEW: маршрут остановлен: loop-ceiling — потолок кругов цикла исчерпан: 2 из 2' \
  "строка остановки называет узел и причину"
assert_eq 444 "$(stat -c %a "$state/t${task}.report.r1.md")" \
  "отчёт исполнителя закрыт на запись после его коммита"
attempt=$(registry_value ATTEMPT_ID)

# --- resume без подъёма потолка: модель не запускается ------------------------------
: >"$LOOP_CALLS"
interventions_before=$(human_interventions)
read -r opened_before closed_before <<<"$interventions_before"
(( opened_before > closed_before ))
assert_rc 0 "$?" "остановка по потолку открыла вмешательство человека ($interventions_before)"
FACTORY_FORBID_LIVE=0 timeout -k 5 120 "$FACTORY_HOME/bin/factory" "$task" resume --profile demo-profile \
  --attempt "$attempt" --routes-dir "$routes" \
  --state-dir "$state" --control-dir "$control" >"$TEST_ROOT/resume-1.log" 2>&1
resume_plain_rc=$?
assert_rc 0 "$resume_plain_rc" "resume без подъёма потолка завершается штатно"
if (( resume_plain_rc != 0 )); then
  tail -20 "$TEST_ROOT/resume-1.log"
fi
assert_eq '' "$(cat "$LOOP_CALLS")" "без подъёма потолка модель не запускалась"
assert_contains "$(cat "$state/logs/t${task}.stages.log")" 'потолок кругов цикла не поднят' \
  "журнал объясняет, почему цикл не продолжен"
# Отказ продолжать не снимает ожидание человека ни в реестре, ни в lifecycle: иначе
# кокпит после выхода демона принял бы штатную остановку за падение.
assert_eq 1 "$(registry_value STALLED_HUMAN)" "реестр по-прежнему ждёт человека"
assert_eq stopped-loop-ceiling "$(registry_value RESULT)" "реестр по-прежнему называет остановку"
assert_eq "$interventions_before" "$(human_interventions)" \
  "вмешательство человека в lifecycle остаётся открытым"

# --- поднятый потолок: тот же кандидат исполняется, дальше приёмка ------------------
write_profile 3
cat >"$LOOP_SCRIPT" <<'TXT'
BUILD|done|||
REVIEW|done|||
TXT
FACTORY_FORBID_LIVE=0 timeout -k 5 180 "$FACTORY_HOME/bin/factory" "$task" resume --profile demo-profile \
  --attempt "$attempt" --routes-dir "$routes" \
  --state-dir "$state" --control-dir "$control" >"$TEST_ROOT/resume-2.log" 2>&1
resume_rc=$?
assert_rc 0 "$resume_rc" "resume после подъёма потолка продолжает цикл"
if (( resume_rc != 0 )); then
  tail -20 "$TEST_ROOT/resume-2.log"
fi
assert_eq "$(printf '%s\n' \
  'BUILD:worker:worker:t7101.report.r3.md' \
  'REVIEW:lead:lead:t7101.report.r3.md')" "$(cat "$LOOP_CALLS")" \
  "продолжение отдаёт работу исполнителю и возвращает её ведущему"
assert_eq waiting "$(registry_value GATE_ACCEPT)" "принятая работа ждёт человека на воротах"
assert_eq 3 "$(registry_value LOOP_ROUND)" "продолжение списало ровно один круг"
assert_eq 3 "$(registry_value LOOP_MAX_ROUNDS)" "реестр показывает поднятый потолок"
assert_contains "$(cat "$state/logs/t${task}.stages.log")" \
  'BUILD: цикл продолжен после поднятого потолка кругов' \
  "журнал фиксирует продолжение"
assert_eq t7101.report.r3.md "$(registry_value LOOP_REPORT)" \
  "реестр называет последний сданный отчёт исполнителя"

# --- Повторный визит исполнителя в том же круге: ручной возврат и повтор без результата
# Возврат человека круг не прибавляет: сданный отчёт круга закрыт на запись и остаётся
# доказательством, а новый визит пишет свой файл. Заход без результата отчёт не сдаёт —
# его продолжение пишет в тот же незаконченный файл.
report_before=$(cat "$state/t${task}.report.r3.md")
launch "$TEST_ROOT/goto.log" goto --profile demo-profile --attempt "$attempt" --node build \
  --reason 'Перепроверь результат круга'
assert_rc 0 "$?" "ручной возврат в исполнителя принят"
: >"$LOOP_CALLS"
printf '%s\n' 'BUILD|noresult|||' >"$LOOP_SCRIPT"
launch "$TEST_ROOT/revisit-1.log" resume --profile demo-profile --attempt "$attempt"
assert_rc 0 "$?" "повторный визит без результата останавливается штатно"
assert_eq 'BUILD:worker:worker:t7101.report.r3.v2.md' "$(cat "$LOOP_CALLS")" \
  "повторный визит получил свой отчёт, а не сданный"
[[ -w "$state/t${task}.report.r3.v2.md" ]]
assert_rc 0 "$?" "отчёт визита без результата остаётся открытым для продолжения"
assert_eq t7101.report.r3.md "$(registry_value LOOP_REPORT)" \
  "заход без результата отчёт не сдаёт"
: >"$LOOP_CALLS"
cat >"$LOOP_SCRIPT" <<'TXT'
BUILD|done|||
REVIEW|done|||
TXT
launch "$TEST_ROOT/revisit-2.log" resume --profile demo-profile --attempt "$attempt"
assert_rc 0 "$?" "продолжение повторного визита доходит до ворот"
assert_eq "$(printf '%s\n' \
  'BUILD:worker:worker:t7101.report.r3.v2.md' \
  'REVIEW:lead:lead:t7101.report.r3.v2.md')" "$(cat "$LOOP_CALLS")" \
  "продолжение пишет тот же отчёт визита, ведущий читает его"
assert_eq 444 "$(stat -c %a "$state/t${task}.report.r3.v2.md")" \
  "сданный отчёт повторного визита закрыт на запись"
assert_eq "$report_before" "$(cat "$state/t${task}.report.r3.md")" \
  "отчёт прежнего визита остался как был"
assert_eq t7101.report.r3.v2.md "$(registry_value LOOP_REPORT)" \
  "ворота приёмки видят отчёт последнего визита"
assert_eq '' "$(grep -h 'Permission denied\|Отказано в доступе' "$state/logs/"* 2>/dev/null)" \
  "ни один заход не упёрся в закрытый отчёт"

# --- recover из цикла в обычный маршрут: признаки цикла не переживают попытку --------
launch "$TEST_ROOT/abandon.log" abandon --profile demo-profile --attempt "$attempt" \
  --reason 'перевод на обычный маршрут'
assert_rc 0 "$?" "попытка цикла закрыта"
launch "$TEST_ROOT/recover.log" recover --profile demo-profile --attempt "$attempt" \
  --reason 'перевод на обычный маршрут' --route plain
assert_rc 0 "$?" "recover создаёт попытку обычного маршрута"
recovered=$(tail -n 1 "$TEST_ROOT/recover.log")
assert_eq '' "$(registry_value LOOP_MODE)" "recover снимает признак цикла прежней попытки"
assert_eq '' "$(registry_value LOOP_REPORT)" "recover снимает отчёт прежней попытки из витрины"
assert_eq '' "$(find "$state" -maxdepth 1 -name "t${task}.report.r*")" \
  "отчёты кругов прежней попытки убраны с пути новой"
: >"$LOOP_CALLS"
cat >"$LOOP_SCRIPT" <<'TXT'
REVIEW|failed|build|p1=Правка обычного маршрута|
BUILD|done|||
REVIEW|done|||
TXT
launch "$TEST_ROOT/recover-resume.log" resume --profile demo-profile --attempt "$recovered"
assert_rc 0 "$?" "обычный маршрут после recover доходит до ворот"
assert_eq "$(printf '%s\n' \
  'REVIEW:::t7101.report.md' 'BUILD:::t7101.report.md' 'REVIEW:::t7101.report.md')" \
  "$(cat "$LOOP_CALLS")" "обычный маршрут не получает ни роли цикла, ни отчёта круга"
assert_eq '' "$(registry_value LOOP_MODE)" "обычный маршрут не помечен циклом — арбитр доступен"
assert_eq waiting "$(registry_value GATE_ACCEPT)" "обычный маршрут ждёт человека на воротах"
launch "$TEST_ROOT/abandon-plain.log" abandon --profile demo-profile --attempt "$recovered" \
  --reason 'проверка закончена'
assert_rc 0 "$?" "попытка обычного маршрута закрыта"

# --- Свежий старт обычного маршрута: признака цикла в реестре нет вовсе -------------
task=7102
sed "s/7101/$task/g" "$TEST_ROOT/ticket.json" >"$TEST_ROOT/ticket-$task.json"
: >"$LOOP_CALLS"
printf '%s\n' 'REVIEW|done|||' >"$LOOP_SCRIPT"
launch "$TEST_ROOT/plain-start.log" start --profile demo-profile --route plain \
  --ticket-json "$TEST_ROOT/ticket-$task.json"
assert_rc 0 "$?" "обычный маршрут стартует тем же launcher"
assert_eq 'REVIEW:::t7102.report.md' "$(cat "$LOOP_CALLS")" "обычный маршрут идёт без роли цикла"
assert_eq нет "$(registry_has LOOP_MODE)" "обычный маршрут не получает признака цикла"
assert_eq нет "$(registry_has LOOP_MAX_ROUNDS)" "обычный маршрут не получает потолка кругов"
launch "$TEST_ROOT/abandon-7102.log" abandon --profile demo-profile \
  --attempt "$(registry_value ATTEMPT_ID)" --reason 'проверка закончена'
assert_rc 0 "$?" "попытка свежего обычного маршрута закрыта"

finish_tests
