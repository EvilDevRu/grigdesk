#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runners/kimi.sh"

# Kimi не пишет работу субагентов в stream-json вовсе: делегировав инструментом
# `Agent`, CLI молчит в stdout до самого конца делегирования (доказано на t7783).
# Журнал этапа замирал на десятки минут при здоровом ходе, а fanout был всегда 0.
# Мост переливает поток CLI байт-в-байт и вливает события субагентов из wire.jsonl.

BRIDGE="$FACTORY_HOME/lib/runners/kimi-wire.py"
assert_file_exists "$BRIDGE" "мост телеметрии лежит рядом с раннером"

wire_path() {
  local dir="$1/sessions/wd_test_0000/session_test/agents/$2"
  mkdir -p "$dir"
  printf '%s\n' "$dir/wire.jsonl"
}

loop_event() {
  printf '{"type":"context.append_loop_event","time":1,"event":%s}\n' "$1"
}

valid_ndjson() {
  python3 - "$1" <<'PYTHON'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        if line.strip():
            json.loads(line)
PYTHON
}

# --- поток CLI не искажается ------------------------------------------------
# Строки CLI доходят до 32 КБ (замер живого прогона) — это много больше PIPE_BUF,
# поэтому мост обязан быть единственным писателем и переливать поток дословно.
test_note "перелив потока CLI"
plain_home="$TEST_ROOT/home-plain"
mkdir -p "$plain_home"
cli_in="$TEST_ROOT/cli-in.jsonl"
cli_out="$TEST_ROOT/cli-out.jsonl"
{
  printf '{"role":"assistant","content":"привет"}\n'
  python3 -c 'print("{\"role\":\"tool\",\"tool_call_id\":\"t1\",\"content\":\"" + "ы" * 40000 + "\"}")'
  printf '{"role":"meta","type":"session.resume_hint","session_id":"s1"}\n'
} >"$cli_in"

python3 "$BRIDGE" --merge "$plain_home" <"$cli_in" >"$cli_out"
assert_rc 0 "$?" "мост завершается успешно без сессий kimi"
cmp -s "$cli_in" "$cli_out"
assert_rc 0 "$?" "поток CLI переливается байт-в-байт, включая строку в 80 КБ"

# --- события субагентов вливаются, работа main не дублируется ----------------
test_note "вливание событий субагентов"
sub_home="$TEST_ROOT/home-sub"
sub_wire=$(wire_path "$sub_home" agent-0)
{
  loop_event '{"type":"content.part","part":{"type":"think","think":"размышление субагента"}}'
  loop_event '{"type":"content.part","part":{"type":"text","text":"текст субагента"}}'
  loop_event '{"type":"tool.call","toolCallId":"tool_A","name":"Read","args":{"file":"x.txt"}}'
  loop_event '{"type":"tool.result","toolCallId":"tool_A","result":{"output":"прочитанное субагентом"}}'
  loop_event '{"type":"step.begin","step":1}'
} >"$sub_wire"

main_wire=$(wire_path "$sub_home" main)
{
  loop_event '{"type":"tool.call","toolCallId":"tool_B","name":"Bash","args":{"command":"ls"}}'
  loop_event '{"type":"tool.result","toolCallId":"tool_B","result":{"output":"вывод main"}}'
  printf 'это не json\n'
  loop_event '{"type":"tool.call","toolCallId":"tool_C","name":"Agent","args":{"subagent_type":"coder"}}'
  loop_event '{"type":"tool.result","toolCallId":"tool_C","result":{"output":"субагент закончил"}}'
} >"$main_wire"

merged="$TEST_ROOT/merged.jsonl"
printf '{"role":"assistant","content":"строка самого CLI"}\n' \
  | python3 "$BRIDGE" --merge "$sub_home" >"$merged"
assert_rc 0 "$?" "битая строка wire.jsonl не роняет мост"
merged_text=$(cat "$merged")

valid_ndjson "$merged"
assert_rc 0 "$?" "журнал остаётся валидным NDJSON"
assert_contains "$merged_text" '{"role":"assistant","content":"строка самого CLI"}' \
  "строка CLI доезжает до журнала нетронутой"
assert_contains "$merged_text" 'размышление субагента' "размышления субагента видны в журнале"
assert_contains "$merged_text" 'текст субагента' "текст субагента виден в журнале"
assert_contains "$merged_text" 'прочитанное субагентом' "результат инструмента субагента виден"
assert_contains "$merged_text" '"agent": "agent-0"' "происхождение события помечено субагентом"
assert_contains "$merged_text" '"bridge": "kimi-wire"' "подмешанное событие отличимо от потока CLI"

# Инструменты main CLI печатает сам — мост обязан молчать о них, иначе журнал
# получит вторую копию каждого действия главного агента.
grep -q '"name": "Bash"' "$merged"
assert_rc 1 "$?" "обычный инструмент main не дублируется мостом"
grep -q 'вывод main' "$merged"
assert_rc 1 "$?" "результат обычного инструмента main не дублируется"

# Делегирование — исключение: его в stdout нет вовсе, поэтому мостится и вызов,
# и его итог (иначе не видно, чем закончился субагент).
assert_contains "$merged_text" '"name": "Agent"' "факт делегирования попадает в журнал"
assert_contains "$merged_text" 'субагент закончил' "итог делегирования попадает в журнал"

# --- classify не смягчается: подмешанное событие = доказанная активность ------
test_note "инвариант classify"
_runner_kimi_no_model_activity "$TEST_ROOT" >/dev/null 2>&1
activity_rc=$?
# В журнал кладём ТОЛЬКО подмешанные мостом строки: они одни и должны доказывать,
# что работа была. Иначе переключение провайдера перезапустило бы стадию, которую
# субагенты уже частично выполнили.
grep '"bridge": "kimi-wire"' "$merged" >"$TEST_ROOT/events.jsonl"
_runner_kimi_no_model_activity "$TEST_ROOT"
assert_rc 1 "$?" "события субагентов считаются активностью (fail-closed сохраняется)"
assert_rc 0 "$activity_rc" "без журнала активность по-прежнему не доказана"

# --- fanout считается по wire.jsonl, а не грепом ------------------------------
# `llm.tools_snapshot` несёт ОПИСАНИЕ инструмента Agent, поэтому греп по имени
# дал бы ненулевой fanout на ходе, где делегирований не было ни одного.
test_note "счёт делегирований"
snapshot_home="$TEST_ROOT/home-snapshot"
snapshot_wire=$(wire_path "$snapshot_home" main)
{
  printf '%s\n' '{"type":"llm.tools_snapshot","tools":[{"name":"Agent","description":"delegate work"}]}'
  loop_event '{"type":"tool.call","toolCallId":"tool_D","name":"Bash","args":{"command":"ls"}}'
} >"$snapshot_wire"
assert_eq 0 "$(python3 "$BRIDGE" --fanout "$snapshot_home")" \
  "описание инструмента Agent не считается делегированием"

fanout_home="$TEST_ROOT/home-fanout"
fanout_main=$(wire_path "$fanout_home" main)
{
  printf '%s\n' '{"type":"llm.tools_snapshot","tools":[{"name":"Agent","description":"delegate work"}]}'
  loop_event '{"type":"tool.call","toolCallId":"tool_E","name":"Agent","args":{"subagent_type":"coder"}}'
  loop_event '{"type":"tool.call","toolCallId":"tool_F","name":"Agent","args":{"subagent_type":"tester"}}'
} >"$fanout_main"
# Субагент вправе делегировать дальше: считаем ВСЕ порождённые ходы, а не только
# делегирования верхнего уровня — цифра отвечает на «сколько агентов работало».
fanout_sub=$(wire_path "$fanout_home" agent-0)
loop_event '{"type":"tool.call","toolCallId":"tool_G","name":"Agent","args":{"subagent_type":"coder"}}' \
  >"$fanout_sub"
assert_eq 3 "$(python3 "$BRIDGE" --fanout "$fanout_home")" \
  "делегирования считаются во всех агентах хода"
assert_eq 0 "$(python3 "$BRIDGE" --fanout "$TEST_ROOT/нет-такого-home")" \
  "отсутствующий per-run home даёт ноль, а не ошибку"

# --- связка с раннером --------------------------------------------------------
test_note "runner_kimi_run и runner_kimi_fanout_count"
default_home="$TEST_ROOT/kimi-default-home"
mkdir -p "$default_home"
printf 'default_model = "kimi-code/k3"\n\n[thinking]\nenabled = true\neffort = "high"\n' \
  >"$default_home/config.toml"
export KIMI_CODE_HOME="$default_home"

factory_exec() {
  local kind=$1
  shift
  [[ "$kind" == provider ]] || return 2
  printf '{"role":"assistant","content":"строка CLI"}\n'
  printf '{"role":"meta","type":"session.resume_hint","session_id":"s2"}\n'
  return 7
}

run_dir="$TEST_ROOT/run-bridged"
mkdir -p "$run_dir"
run_wire=$(wire_path "$run_dir/kimi-home" agent-0)
loop_event '{"type":"content.part","part":{"type":"text","text":"работа субагента"}}' >"$run_wire"
run_main=$(wire_path "$run_dir/kimi-home" main)
loop_event '{"type":"tool.call","toolCallId":"tool_H","name":"Agent","args":{"subagent_type":"coder"}}' \
  >"$run_main"

runner_kimi_run 42 prompt BUILD k3 '' 30 "$run_dir" >"$TEST_ROOT/run-out.jsonl"
assert_rc 7 "$?" "исход хода берётся у CLI, а не у моста"
run_out=$(cat "$TEST_ROOT/run-out.jsonl")
assert_contains "$run_out" 'строка CLI' "поток CLI проходит через мост в журнал"
assert_contains "$run_out" 'работа субагента' "раннер вливает события субагентов в журнал"
assert_eq 1 "$(runner_kimi_fanout_count "$run_dir")" "fanout читается из per-run home"

run_empty="$TEST_ROOT/run-empty"
mkdir -p "$run_empty"
assert_eq 0 "$(runner_kimi_fanout_count "$run_empty")" "ход без делегирований даёт ноль"

# Без python3 мост пропускается: телеметрия субагентов не стоит отказа стадии.
test_note "деградация без python3"
saved_path="$PATH"
stub_bin="$TEST_ROOT/stub-bin"
mkdir -p "$stub_bin"
for tool in cat cp chmod command grep ln mkdir printf timeout; do
  [[ -x "/usr/bin/$tool" ]] && ln -sf "/usr/bin/$tool" "$stub_bin/$tool"
done
PATH="$stub_bin"
run_plain="$TEST_ROOT/run-plain"
mkdir -p "$run_plain"
plain_wire=$(wire_path "$run_plain/kimi-home" agent-0)
loop_event '{"type":"content.part","part":{"type":"text","text":"работа субагента"}}' >"$plain_wire"
runner_kimi_run 42 prompt BUILD k3 '' 30 "$run_plain" >"$TEST_ROOT/run-plain-out.jsonl"
plain_rc=$?
PATH="$saved_path"
assert_rc 7 "$plain_rc" "без python3 ход идёт как раньше"
plain_out=$(cat "$TEST_ROOT/run-plain-out.jsonl")
assert_contains "$plain_out" 'строка CLI' "без python3 поток CLI не теряется"
grep -q 'работа субагента' "$TEST_ROOT/run-plain-out.jsonl"
assert_rc 1 "$?" "без python3 обогащения нет, но и поломки нет"

finish_tests
