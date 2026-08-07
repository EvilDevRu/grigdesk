#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runners/codex.sh"

# В отличие от kimi (KIMI.md: работа субагентов не видна в stream-json вовсе)
# codex публикует протокол совместной работы прямо в поток: item типа
# `collab_tool_call` с sender_thread_id и receiver_thread_ids. Конверты ниже —
# дословная форма живой телеметрии (замер 222 прогонов, 2026-08-07), поэтому
# счётчик проверяется на том, что действительно приходит от CLI, а не на
# придуманном формате.

run_dir="$TEST_ROOT/run"
mkdir -p "$run_dir"
events="$run_dir/events.jsonl"

collab() { # tool, статус, получатели
  printf '{"type":"item.completed","item":{"id":"item_%s","type":"collab_tool_call","tool":"%s","sender_thread_id":"019fcdd9-461d-7611-a37a-1a26e44a67ae","receiver_thread_ids":[%s],"prompt":null,"agents_states":{},"status":"%s"}}\n' \
    "$RANDOM" "$1" "$3" "$2"
}

# --- ход без делегирования -------------------------------------------------
# Ровно то, что видно на всех живых прогонах: collab-вызовы есть, получателей нет.
test_note "ход без делегирования"
{
  printf '{"type":"thread.started","thread_id":"019fcdd9-461d-7611-a37a-1a26e44a67ae"}\n'
  printf '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls"}}\n'
  collab wait completed ''
  collab wait completed ''
} >"$events"
assert_eq '0' "$(runner_codex_fanout_count "$run_dir")" \
  "collab-вызовы без получателей не считаются делегированием"

# --- ход с делегированием --------------------------------------------------
# Считаем РАЗНЫЕ треды-получатели, а не вызовы: ожидание одного и того же
# субагента повторяется, и по вызовам fanout вырос бы на ровном месте.
test_note "ход с делегированием"
{
  collab wait in_progress '"thread-a","thread-b"'
  collab wait completed '"thread-a"'
  collab wait completed '"thread-b"'
} >"$events"
assert_eq '2' "$(runner_codex_fanout_count "$run_dir")" \
  "два разных треда-получателя дают fanout 2"

# --- мусор в журнале не ломает счёт ----------------------------------------
# Журнал пишется на лету: последняя строка оборванного хода бывает неполной.
test_note "устойчивость к битым строкам"
{
  collab wait completed '"thread-a"'
  printf '{"type":"item.completed","item":{"type":"collab_tool_ca\n'
  printf 'не json вовсе\n'
  printf '\n'
} >"$events"
assert_eq '1' "$(runner_codex_fanout_count "$run_dir")" \
  "битые строки пропускаются, а не обнуляют результат"

# --- имя инструмента в тексте не считается ---------------------------------
# Ровно та ловушка, на которой обжигался kimi: греп по имени дал бы ненулевой
# fanout там, где инструмент только упомянут.
test_note "упоминание в тексте не считается"
{
  printf '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"вызову collab_tool_call с receiver_thread_ids: [\\"thread-z\\"]"}}\n'
  printf '{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"grep collab_tool_call events.jsonl"}}\n'
} >"$events"
assert_eq '0' "$(runner_codex_fanout_count "$run_dir")" \
  "упоминание протокола в тексте и в команде не считается делегированием"

# --- журнала нет ------------------------------------------------------------
# Ход мог не дожить до первой строки; telemetry-функция обязана не падать.
test_note "журнала нет"
rm -f "$events"
assert_eq '0' "$(runner_codex_fanout_count "$run_dir")" \
  "отсутствие журнала даёт 0, а не ошибку"
runner_codex_fanout_count "$run_dir" >/dev/null
assert_rc 0 "$?" "функция завершается успешно даже без журнала"

finish_tests
