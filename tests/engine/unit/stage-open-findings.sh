#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

# Возврат по `failed` — разговор двух узлов: критик пишет typed-находки, диспетчер
# возвращает курсор автору. До 22.08.2026 текст находок доезжал до автора ТОЛЬКО когда
# маршрут объявлял у него `evidence` в requiredContext (render_node вклеивает ровно
# перечисленные секции), а профили делали это вразнобой. Слепой автор повторял прошлый
# заход, критик находил те же дефекты слово в слово, и попытка умирала об `no-progress`.
# Живой случай: пара «автор тестов ↔ критик тестов», два круга по ~25 минут впустую.
#
# Поэтому доставка находок — инвариант ДВИЖКА: блок собирается независимо от
# requiredContext маршрута.

export FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture" "$TEST_ROOT/work"
printf '%s\n' \
  'RUNNERS_SCHEMA=1' \
  'CONFIG_REVISION=1' \
  'PROJECT_RUNNER_PRIMARY=alpha' \
  'PROJECT_RUNNER_FAILOVER=beta' \
  'MODEL_BUILD_ALPHA_FAMILY=fixture' \
  'MODEL_BUILD_ALPHA_VERSION=latest' \
  'MODEL_BUILD_ALPHA_EFFORT=high' >"$FACTORY_PROFILES_DIR/fixture/runners.env"

PROFILE_NAME=fixture
PROFILE_CTX=fixture
PROFILE_AGENT_CWD="$TEST_ROOT/work"

source "$FACTORY_HOME/lib/core.sh"

multi_runner_run() {
  printf '%s' "$2" >"$TEST_ROOT/prompt"
  return 0
}

OPEN_FINDINGS='[
  {"id":"mutations-tests-assert-old-contract","sourceNode":"tcritic","owner":"product",
   "summary":"mutations.test.js 8/8 зелёный на снятом контракте","status":"open"},
  {"id":"screen-reuse-uncovered","sourceNode":"tcritic","owner":"product",
   "summary":"критерий назвал 4 перехода, проверено 2","status":"open"}
]'

prompt_with() {
  FACTORY_STAGE_OPEN_FINDINGS="${1-}" FACTORY_STAGE_HUMAN_NOTE="${2-}" \
    run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
  cat "$TEST_ROOT/prompt"
}

# --- находки доезжают до агента дословно ---
prompt=$(prompt_with "$OPEN_FINDINGS")
assert_contains "$prompt" 'сделай работу' "исходное задание узла не потеряно"
assert_contains "$prompt" 'Незакрытые находки проверяющих узлов' "блок находок в промпте"
assert_contains "$prompt" 'mutations-tests-assert-old-contract' "id находки доезжает"
assert_contains "$prompt" 'mutations.test.js 8/8 зелёный на снятом контракте' \
  "суть находки доезжает дословно"
assert_contains "$prompt" 'tcritic' "назван узел, который нашёл"
assert_contains "$prompt" 'screen-reuse-uncovered' "вторая находка не теряется"

has_block() {
  [[ "$1" == *'Незакрытые находки проверяющих узлов'* ]] && printf 'да' || printf 'нет'
}

# --- нечего показывать: блока нет вовсе ---
# Пустой список не должен превращаться в пустую рубрику: узел, зашедший впервые,
# не обязан читать заголовок про находки, которых нет.
assert_eq нет "$(has_block "$(prompt_with '[]')")" "пустой список блока не даёт"
assert_eq нет "$(has_block "$(prompt_with '')")" "отсутствие переменной блока не даёт"

# --- повреждённый вход не роняет заход ---
# Находки усиливают промпт, но не являются условием исполнения: сломанный JSON обязан
# стоить блока, а не всего этапа с уже потраченными минутами агента.
prompt=$(prompt_with 'не json')
assert_contains "$prompt" 'сделай работу' "битый JSON не отменяет запуск узла"
assert_eq нет "$(has_block "$prompt")" "битый JSON блока не даёт"
prompt=$(prompt_with '{"open":[]}')
assert_contains "$prompt" 'сделай работу' "не-массив не отменяет запуск узла"
assert_eq нет "$(has_block "$prompt")" "не-массив блока не даёт"

# --- слово человека сильнее машинных находок и идёт ПОСЛЕ них ---
# Человек мог вернуть узел именно затем, чтобы свернуть с прежнего пути; тогда его
# указание обязано читаться последним, а не тонуть выше списка находок.
prompt=$(prompt_with "$OPEN_FINDINGS" 'не чини это, перепиши иначе')
findings_at=$(awk '/Незакрытые находки проверяющих узлов/{print NR; exit}' <<<"$prompt")
human_at=$(awk '/Указание человека при возврате на этот узел/{print NR; exit}' <<<"$prompt")
assert_contains "$prompt" 'не чини это, перепиши иначе' "указание человека на месте"
order=нет
[[ -n "$findings_at" && -n "$human_at" && "$findings_at" -lt "$human_at" ]] && order=да
assert_eq да "$order" "находки идут перед словом человека ($findings_at до $human_at)"

# --- извлечение из контекста: только open, и не зависит от requiredContext ---
source "$FACTORY_HOME/lib/route-runtime.sh" 2>/dev/null || true
if declare -F _route_v2_open_findings_from_context >/dev/null; then
  ctx="$TEST_ROOT/context.json"
  cat >"$ctx" <<'JSON'
{
  "task": {"id": "41"},
  "evidence": {
    "eventCount": 7,
    "findings": {
      "schema": 1,
      "open": [{"id":"open-one","sourceNode":"review","owner":"product",
                "summary":"открытая находка","status":"open"}],
      "closed": [{"id":"closed-one","sourceNode":"review","owner":"product",
                  "summary":"закрытая находка","status":"closed"}],
      "deferred": [{"id":"deferred-one","sourceNode":"review","owner":"product",
                    "summary":"отложенная находка","status":"deferred"}]
    }
  }
}
JSON
  extracted=$(_route_v2_open_findings_from_context "$ctx")
  assert_contains "$extracted" 'open-one' "из контекста берутся открытые находки"
  has_closed=нет; [[ "$extracted" == *closed-one* ]] && has_closed=да
  has_deferred=нет; [[ "$extracted" == *deferred-one* ]] && has_deferred=да
  assert_eq нет "$has_closed" "закрытые находки в промпт не идут"
  assert_eq нет "$has_deferred" "отложенные адресованы человеку на воротах, не автору"

  # Секция evidence живёт в контексте всегда, поэтому её наличие не зависит от того,
  # объявил ли маршрут evidence в requiredContext. Это и есть суть починки.
  printf '%s' '{"task":{"id":"41"}}' >"$ctx"
  assert_eq "" "$(_route_v2_open_findings_from_context "$ctx")" \
    "контекст без evidence даёт пустоту, а не ошибку"
  printf '%s' 'не json' >"$ctx"
  assert_eq "" "$(_route_v2_open_findings_from_context "$ctx")" \
    "битый контекст даёт пустоту, а не ошибку"
  assert_eq "" "$(_route_v2_open_findings_from_context "$TEST_ROOT/нет-такого.json")" \
    "отсутствующий контекст даёт пустоту"
fi
