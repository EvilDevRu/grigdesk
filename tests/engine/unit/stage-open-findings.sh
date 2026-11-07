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

# --- Ступень 0 лестницы: движок отдаёт заходу СВОЙ диагноз, а не два числа ---
# openedSequence и lastSeenSequence приезжали в контекст с самого начала, но как числа:
# агент видел их и всё равно заходил на третий круг с прежним подходом. Диагноз считает
# движок, потому что он же и остановит маршрут по этому признаку.
LOOPED_FINDINGS='[
  {"id":"survived-repair","sourceNode":"review","owner":"build",
   "summary":"граница не проверяется","status":"open",
   "openedSequence":4,"lastSeenSequence":9},
  {"id":"just-appeared","sourceNode":"review","owner":"build",
   "summary":"новый дефект","status":"open",
   "openedSequence":9,"lastSeenSequence":9}
]'

prompt=$(prompt_with "$LOOPED_FINDINGS")
assert_contains "$prompt" 'ПЕРЕЖИЛА РЕМОНТ' "пережившая ремонт находка помечена в списке"
assert_contains "$prompt" 'Диагноз движка' "диагноз топтания вклеен в промпт"
assert_contains "$prompt" 'Пережили ремонт: survived-repair' "диагноз называет находку поимённо"
assert_contains "$prompt" 'объяви, что закрыть нельзя' \
  "агенту назван законный выход, кроме ещё одного круга"

# Свежая находка пометки не получает: иначе «пережила ремонт» перестанет что-либо значить.
fresh_line=$(grep -F 'just-appeared' <<<"$prompt")
fresh_marked=нет; [[ "$fresh_line" == *'ПЕРЕЖИЛА РЕМОНТ'* ]] && fresh_marked=да
assert_eq нет "$fresh_marked" "свежая находка меткой топтания не помечается"

# --- без признаков топтания диагноза нет вовсе ---
# Блок «диагноз» обязан появляться только по факту. Постоянный текст про топтание в
# каждом заходе обесценился бы к третьему разу — ровно как обесценивались числа.
has_diagnosis() {
  [[ "$1" == *'Диагноз движка'* ]] && printf 'да' || printf 'нет'
}
assert_eq нет "$(has_diagnosis "$(prompt_with "$OPEN_FINDINGS")")" \
  "находки без номеров заходов диагноза не дают"
FRESH_ONLY='[{"id":"only-fresh","sourceNode":"review","owner":"build",
  "summary":"первый проход","status":"open","openedSequence":3,"lastSeenSequence":3}]'
assert_eq нет "$(has_diagnosis "$(prompt_with "$FRESH_ONLY")")" \
  "первый проход диагноза не даёт"

# --- битые номера не выдумывают топтание ---
# Номер захода — производная проекция ledger; строка или null означают «не знаю»,
# а не «пережила ремонт». Ложный диагноз здесь дороже отсутствующего: он велит агенту
# сменить подход там, где прежний ещё не пробовали.
BROKEN_SEQ='[{"id":"broken","sourceNode":"review","owner":"build",
  "summary":"номера сломаны","status":"open","openedSequence":"4","lastSeenSequence":null}]'
prompt=$(prompt_with "$BROKEN_SEQ")
assert_contains "$prompt" 'broken' "находка с битыми номерами всё равно доезжает"
assert_eq нет "$(has_diagnosis "$prompt")" "битые номера заходов диагноза не дают"

# bool в питоне является int, поэтому `true`/`false` прошли бы проверку типа и дали бы
# `true > false` — то есть выдуманный диагноз на повреждённой проекции.
BOOL_SEQ='[{"id":"boolish","sourceNode":"review","owner":"build",
  "summary":"номера булевы","status":"open","openedSequence":false,"lastSeenSequence":true}]'
prompt=$(prompt_with "$BOOL_SEQ")
assert_contains "$prompt" 'boolish' "находка с булевыми номерами доезжает"
assert_eq нет "$(has_diagnosis "$prompt")" "булевы номера заходов диагноза не дают"

# --- отложенные находки тоже доезжают, но с обратным смыслом ---
# Раньше `deferred` считались адресованными человеку на воротах и в промпт узлов не шли
# вовсе. Цена: проверяющий, не зная о собственной прошлой отложенной находке, находил её
# СНОВА следующим кругом. Замер по журналам всех попыток — 8 попыток из 29 переоткрывают
# тот же id на том же узле, одна трижды. Каждый повтор занимает место в лимите находок
# вердикта, а человеку на воротах приходится второй раз говорить «это мы уже отложили».
deferred_prompt() {
  FACTORY_STAGE_OPEN_FINDINGS="${2-}" FACTORY_STAGE_DEFERRED_FINDINGS="${1-}" \
    run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
  cat "$TEST_ROOT/prompt"
}

DEFERRED='[{"id":"browser-gpu-step-no-input","sourceNode":"skeptic","owner":"plan",
  "summary":"конфликтного DWG в checkout нет","status":"deferred"}]'
prompt=$(deferred_prompt "$DEFERRED")
assert_contains "$prompt" 'Уже отложенные находки' "блок отложенных находок появляется"
assert_contains "$prompt" 'browser-gpu-step-no-input' "отложенная находка названа по id"
assert_contains "$prompt" 'не подавай их заново' "узлу сказано не открывать их снова"

# Смысл у двух списков РАЗНЫЙ, и перепутать их нельзя: открытые — работа, отложенные — нет.
# Поэтому отложенная находка не должна попадать в блок открытых.
case "$prompt" in
  *'Незакрытые находки'*)
    test_fail "отложенная находка не выдаётся за работу" "$prompt" ;;
  *)
    test_ok "отложенная находка не выдаётся за работу" ;;
esac

# Порядок: сначала «что чинить», потом «что решено не чинить». Обратный читался бы
# как список работы.
both=$(deferred_prompt "$DEFERRED" "$OPEN_FINDINGS")
open_at=${both%%Незакрытые находки*}
deferred_at=${both%%Уже отложенные находки*}
assert_eq 0 "$(( ${#open_at} < ${#deferred_at} ? 0 : 1 ))" \
  "открытые находки идут раньше отложенных"

# Пустой список и повреждённый JSON блока не дают: отсутствие отложенных находок ничем
# не пахнет и не должно печатать пустую рубрику.
for broken in '[]' 'не json' '{"id":"x"}'; do
  prompt=$(deferred_prompt "$broken")
  case "$prompt" in
    *'Уже отложенные находки'*)
      test_fail "пустой или повреждённый список отложенных блока не даёт" "$broken" ;;
    *)
      test_ok "пустой или повреждённый список отложенных блока не даёт ($broken)" ;;
  esac
done

finish_tests
