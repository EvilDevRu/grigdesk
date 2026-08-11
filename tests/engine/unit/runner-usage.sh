#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

# `usage` — ОПЦИОНАЛЬНЫЙ метод раннера: сколько токенов стоил завершённый ход.
# Без него узел маршрута нечем сравнить с соседним по цене, и решение «этот этап
# слишком дорогой, уберём его» принимается на глаз. Данные уже лежат в
# events.jsonl каждого запуска — метод только достаёт их словами своего CLI.

source "$FACTORY_HOME/lib/runners/claude.sh"
source "$FACTORY_HOME/lib/runners/codex.sh"
source "$FACTORY_HOME/lib/runners/kimi.sh"

fixture() { printf '%s\n' "$FACTORY_TESTS_HOME/fixtures/usage/$1"; }
field() { printf '%s\n' "$1" | awk -F= -v k="$2" '$1 == k { print $2; exit }'; }

# Claude складывает расход всего хода сам и печатает его в событии `result`.
# Берём именно его, а не сумму assistant-событий: у CLI своя арифметика, и две
# независимые версии одного числа разойдутся молча.
actual=$(runner_claude_usage "$(fixture claude-usage-complete)")
assert_rc 0 "$?" "claude reports usage of a finished turn"
assert_eq 20 "$(field "$actual" TOKENS_IN)" "claude takes input from the result event"
assert_eq 800 "$(field "$actual" TOKENS_OUT)" "claude takes output from the result event"
assert_eq 90000 "$(field "$actual" TOKENS_CACHE_READ)" "cache read stays a separate field"
assert_eq 9000 "$(field "$actual" TOKENS_CACHE_WRITE)" "cache write stays a separate field"
assert_eq 0.4231 "$(field "$actual" COST_USD)" "claude reports the cost it computed itself"

# Оборванный ход (timeout, KILL, падение хоста) события `result` не оставляет,
# а токены уже потрачены. Это и есть самый дорогой случай, ради которого замер
# заводился, поэтому расход собирается из assistant-событий.
actual=$(runner_claude_usage "$(fixture claude-usage-interrupted)")
assert_rc 0 "$?" "claude still reports usage of an interrupted turn"
assert_eq 800 "$(field "$actual" TOKENS_OUT)" "interrupted turn sums assistant events"
assert_eq 90000 "$(field "$actual" TOKENS_CACHE_READ)" "interrupted turn sums cache reads"
assert_eq "" "$(field "$actual" COST_USD)" "cost is not invented when the CLI never named it"

# `turn.completed` у codex НАКОПИТЕЛЬНЫЙ по всему thread: каждый вызов
# инструмента снова прибавляет весь вход. Сумма таких событий завысила бы расход
# в разы — берём последнее.
actual=$(runner_codex_usage "$(fixture codex-usage-cumulative)")
assert_rc 0 "$?" "codex reports usage from the completed turn"
assert_eq 2400000 "$(field "$actual" TOKENS_IN)" "codex takes the last cumulative snapshot"
assert_eq 100000 "$(field "$actual" TOKENS_OUT)" "codex does not sum cumulative turns"
assert_eq 2200000 "$(field "$actual" TOKENS_CACHE_READ)" "codex maps cached input to cache read"

# Телеметрия без расхода не превращается в нулевой расход: ноль означал бы
# «ход был бесплатным», а это другое утверждение.
actual=$(runner_codex_usage "$(fixture codex-usage-absent)")
assert_rc 1 "$?" "codex stays silent when the stream carries no usage"
assert_eq "" "$actual" "no usage means empty output"

# Метод опционален: ACP-мост kimi расход не публикует вовсе, и прочерк там
# честнее выдуманного нуля.
if declare -F runner_kimi_usage >/dev/null 2>&1; then
  test_note "kimi объявил usage — проверь, что он читает реальный расход"
fi
test_ok "usage is optional for runners whose CLI never reports it"

finish_tests
