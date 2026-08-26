#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runners/claude.sh"

# Отказ политики прав внутри хода. CLI кладёт их в `permission_denials` события `result`,
# и до 26.08.2026 движок это поле не читал вовсе: отказ был виден только грепом по потоку
# внутри каталога прогона.
#
# Опасен не потраченный вызов, а ПОДМЕНА проверки. В живом прогоне нужный запуск «был
# заблокирован политикой», и агент в тот же ход написал «проверю через прямой запуск
# скриптов»; результат подменённой проверки уехал дальше как требуемое доказательство.
# Правило «нет замены — зафиксируй проверку как не выполненную» в промпте уже стояло и
# было нарушено, поэтому нужен машинный признак, а не ещё одна строка регламента.

run_dir="$TEST_ROOT/run"
mkdir -p "$run_dir"
events="$run_dir/events.jsonl"

result_with() { # содержимое поля permission_denials, как есть
  printf '{"type":"result","subtype":"success","is_error":false,"permission_denials":%s}\n' "$1"
}

# --- отказы посчитаны ------------------------------------------------------
test_note "ход с отказами"
{
  printf '{"type":"system","subtype":"init","model":"claude-x"}\n'
  printf '{"type":"assistant","message":{"model":"claude-x","content":[]}}\n'
  result_with '[{"tool_name":"Bash","tool_input":{"command":"pytest"}},{"tool_name":"Bash","tool_input":{"command":"npm run e2e"}}]'
} >"$events"
assert_eq '2' "$(runner_claude_denial_count "$run_dir")" "два отказа политики посчитаны"

# --- отказов не было: это ЧЕСТНЫЙ ноль -------------------------------------
# Ход дошёл до `result`, значит движок действительно знает, что запретов не случилось.
test_note "ход без отказов"
{
  printf '{"type":"assistant","message":{"model":"claude-x","content":[]}}\n'
  result_with '[]'
} >"$events"
assert_eq '0' "$(runner_claude_denial_count "$run_dir")" "пустой список даёт ноль"

# Старый CLI поля не кладёт вовсе. Это тоже ноль: событие результата есть, отказов в нём
# не объявлено. Отличать «нет поля» от «пустой список» нечем и незачем.
{
  printf '{"type":"result","subtype":"success","is_error":false}\n'
} >"$events"
assert_eq '0' "$(runner_claude_denial_count "$run_dir")" "отсутствие поля даёт ноль"

# --- оборванный ход: «не знаем», а не ноль ---------------------------------
# Ключевая граница. У таймаута, KILL и падения процесса события `result` не будет вовсе,
# а отказы в этом ходе могли быть. Записанный ноль означал бы «запретов не случилось» —
# ровно то, чего проверить нельзя. Ненулевой код велит движку не писать ключ, и чип в
# модалке узла не рисуется: пусто честнее выдуманного нуля.
test_note "оборванный ход"
{
  printf '{"type":"system","subtype":"init","model":"claude-x"}\n'
  printf '{"type":"assistant","message":{"model":"claude-x","content":[]}}\n'
} >"$events"
out=$(runner_claude_denial_count "$run_dir"); rc=$?
assert_eq 1 "$rc" "ход без события result отвечает отказом"
assert_eq "" "$out" "оборванный ход не выдаёт ноль за факт"

: >"$events"
out=$(runner_claude_denial_count "$run_dir"); rc=$?
assert_eq 1 "$rc" "пустой журнал отвечает отказом"

rm -f "$events"
out=$(runner_claude_denial_count "$run_dir"); rc=$?
assert_eq 1 "$rc" "отсутствующий журнал отвечает отказом"

# --- мусор в журнале не ломает счёт ----------------------------------------
# Поток пишет чужой CLI: одна битая строка не должна стоить всего замера, но и выдумывать
# по ней ничего нельзя.
test_note "повреждённый журнал"
{
  printf 'не json\n'
  printf '\n'
  printf '{"type":"assistant","message":{"model":"claude-x"}}\n'
  result_with '[{"tool_name":"Bash"}]'
} >"$events"
assert_eq '1' "$(runner_claude_denial_count "$run_dir")" "битая строка не отменяет счёт"

# Поле не того типа — это не отказы. Считаем как отсутствие, а не падаем: движок обязан
# пережить чужой формат.
{ result_with '"три"'; } >"$events"
assert_eq '0' "$(runner_claude_denial_count "$run_dir")" "поле не-список читается как ноль"

# --- несколько событий result ---------------------------------------------
# Штатно оно одно, но живая сессия между ходами способна дать больше одного. Складываем:
# отказ, случившийся в любом из них, остаётся отказом этого захода.
test_note "несколько результатов"
{
  result_with '[{"tool_name":"Bash"}]'
  result_with '[{"tool_name":"Write"},{"tool_name":"Bash"}]'
} >"$events"
assert_eq '3' "$(runner_claude_denial_count "$run_dir")" "отказы всех событий result сложены"
