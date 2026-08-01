#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

# Лимит этапа и то, что о нём знает агент, обязаны идти из ОДНОГО источника: пока
# число жило только в движке, агент планировал проверки вслепую и на t8165 был убит
# за ~40 секунд до отчёта — вместе с готовым кодом, который движок не засчитал.

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

# run_agent зовёт multi_runner_run "$t" "$prompt" "$stage" "$tmo" — перехватываем,
# чтобы увидеть одновременно и фактический лимит, и промпт, который получит агент.
multi_runner_run() {
  printf '%s' "$4" >"$TEST_ROOT/tmo"
  printf '%s' "$2" >"$TEST_ROOT/prompt"
  return 0
}

budget_for() {
  local cls=$1 stage=${2:-BUILD}
  FACTORY_ROUTE_TIMEOUT_CLASS="$cls" run_agent 41 'сделай работу' "$stage" >/dev/null 2>&1
  cat "$TEST_ROOT/tmo"
}

# --- класс узла из бандла маршрута резолвится в секунды ---
assert_eq 3600 "$(budget_for build)" "класс build даёт свой лимит"
assert_eq 3600 "$(budget_for test)" "класс test даёт свой лимит"
assert_eq 5400 "$(budget_for browser)" "класс browser даёт полтора часа"
assert_eq 5400 "$(budget_for diagnostic)" "класс diagnostic даёт полтора часа"
assert_eq 1800 "$(budget_for planning)" "класс planning остаётся получасовым"
assert_eq 1800 "$(budget_for check)" "класс check остаётся получасовым"
assert_eq 1800 "$(budget_for review)" "класс review остаётся получасовым"
assert_eq 1800 "$(budget_for delivery)" "класс delivery остаётся получасовым"
assert_eq 1800 "$(budget_for standard)" "класс standard остаётся получасовым"

# --- узел без класса (старая ревизия бандла, v1-маршрут) ---
assert_eq "$NODE_TIMEOUT" "$(budget_for '')" "без класса действует дефолт движка"

# --- неизвестный класс: fail-open, но след в журнале ---
: >"$LOGDIR/t41.stages.log"
assert_eq "$NODE_TIMEOUT" "$(budget_for quantum)" "неизвестный класс не роняет этап"
assert_contains "$(cat "$LOGDIR/t41.stages.log")" "timeoutClass=quantum" \
  "неизвестный класс виден в журнале этапов"

# --- профиль переопределяет класс: у одного проекта тесты идут втрое дольше ---
profile_timeout_class() { [[ "$1" == build ]] && printf '7200\n'; }
assert_eq 7200 "$(budget_for build)" "профиль переопределяет класс"
assert_eq 5400 "$(budget_for browser)" "непереопределённый класс сохраняет дефолт"
unset -f profile_timeout_class

# --- legacy-хук по имени этапа: только там, где класса нет ---
profile_stage_timeout() { [[ "$1" == BUILD ]] && printf '900\n'; }
assert_eq 900 "$(budget_for '' BUILD)" "без класса работает legacy-хук профиля"
assert_eq 3600 "$(budget_for build BUILD)" "класс узла главнее legacy-хука"
unset -f profile_stage_timeout

# --- регламент доезжает до агента и совпадает с фактическим лимитом ---
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'сделай работу' "исходное задание узла не потеряно"
assert_contains "$prompt" '**60 мин**' "агенту назван жёсткий предел"
assert_contains "$prompt" '**48 мин**' "агенту назван срок фиксации результата"
assert_contains "$prompt" 'stage-result' "агенту названо, чем фиксировать"

FACTORY_ROUTE_TIMEOUT_CLASS=browser run_agent 41 'сделай работу' BROWSER >/dev/null 2>&1
assert_contains "$(cat "$TEST_ROOT/prompt")" '**90 мин**' \
  "регламент следует за классом, а не за константой"

# Числа в промпте и фактический лимит — из одного вызова, расходиться не могут.
FACTORY_ROUTE_TIMEOUT_CLASS=browser run_agent 41 'сделай работу' BROWSER >/dev/null 2>&1
assert_eq 5400 "$(cat "$TEST_ROOT/tmo")" "названный агенту предел равен фактическому"

# --- повтор этапа знает, что он повтор ---
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_RETRY=1 \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
case "$prompt" in
  *'Это повтор этапа'*) test_fail "первый заход не объявлен повтором" "блок повтора найден" ;;
  *) test_ok "первый заход не объявлен повтором" ;;
esac

FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_RETRY=2 FACTORY_STAGE_RETRY_REASON=no-result \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'Это повтор этапа (заход 2)' "повтор назван номером захода"
assert_contains "$prompt" 'не зафиксировав результат' "названа причина: обрыв без результата"
assert_contains "$prompt" 'git status' "повтору велено осмотреть следы предыдущего захода"
assert_contains "$prompt" 'сделай работу' "задание узла не потеряно и на повторе"
assert_contains "$prompt" '**60 мин**' "регламент времени остаётся и на повторе"

FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_RETRY=3 FACTORY_STAGE_RETRY_REASON=failed \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'Это повтор этапа (заход 3)' "третий заход назван своим номером"
assert_contains "$prompt" 'отказом по существу' "названа причина: отказ по существу"

# --- черновик хода: единственное, что переживает обрыв этапа ---
# Терминальный канал (stage-result) срабатывает в конце, поэтому убитый заход уносит всё.
# Черновик держится файлом в STATE_DIR — проверяем и адрес, и то, кому он достаётся.
ckpt=$(_stage_checkpoint_path 41 BUILD)
assert_eq "$STATE_DIR/t41.build.checkpoint.md" "$ckpt" "имя черновика детерминировано по задаче и этапу"
assert_eq "$STATE_DIR/t41.tests.checkpoint.md" "$(_stage_checkpoint_path 41 TESTS)" \
  "у каждого этапа свой черновик"
assert_eq "$STATE_DIR/t41.a_b.checkpoint.md" "$(_stage_checkpoint_path 41 'A/B')" \
  "имя этапа санируется — путь наружу не собрать"

rm -f "$ckpt"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" "ЧЕРНОВИК ХОДА — \`$ckpt\`" "агенту назван адрес черновика"
case "$prompt" in
  *'Черновик незакрытого захода'*) test_fail "пустого черновика в промпте нет" "блок найден" ;;
  *) test_ok "пустого черновика в промпте нет" ;;
esac

# Ключевое: блок отдаётся по НАЛИЧИЮ файла, а не по номеру захода. После убитого
# оркестратора resume входит в узел заново с попыткой №1 — на t8165 было именно так.
printf 'сделан парсер, лежит в src/parse.ts\nосталось: тесты\n' >"$ckpt"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'Черновик незакрытого захода' "черновик доезжает и на первом заходе"
assert_contains "$prompt" 'сделан парсер, лежит в src/parse.ts' "содержимое черновика передано дословно"
assert_contains "$prompt" 'git status' "черновик велено сверить с фактическим состоянием"
assert_contains "$prompt" 'сделай работу' "задание узла не вытеснено черновиком"

# Хвост, а не всё: журнал на мегабайт вытеснил бы из окна само задание.
{ head -c 8000 /dev/zero | tr '\0' 'x'; printf '\nПОСЛЕДНЯЯ СТРОКА\n'; } >"$ckpt"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'ПОСЛЕДНЯЯ СТРОКА' "из длинного черновика взят конец"
assert_eq 0 "$(( ${#prompt} > 20000 ? 1 : 0 ))" "длинный черновик обрезан, а не вставлен целиком"

# Черновик соседнего этапа своим не считается.
printf 'заметки тестов\n' >"$(_stage_checkpoint_path 41 TESTS)"
rm -f "$ckpt"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
case "$(cat "$TEST_ROOT/prompt")" in
  *'заметки тестов'*) test_fail "черновик чужого этапа не подмешивается" "чужой текст в промпте" ;;
  *) test_ok "черновик чужого этапа не подмешивается" ;;
esac

# Снятие: обычный файл убирается, symlink — нет (иначе черновиком сносят чужой файл).
printf 'x\n' >"$ckpt"
_stage_checkpoint_clear 41 BUILD
assert_file_missing "$ckpt" "терминальный исход снимает черновик"
printf 'жертва\n' >"$TEST_ROOT/victim"
ln -s "$TEST_ROOT/victim" "$ckpt"
_stage_checkpoint_clear 41 BUILD
assert_file_exists "$TEST_ROOT/victim" "по symlink черновик чужой файл не сносит"
rm -f "$ckpt" "$(_stage_checkpoint_path 41 TESTS)"

# Кто именно снимает черновик — политика вызывающего, а не примитива. Провал узла не
# «закрывает» его: маршрут останавливается и передаёт человеку, узел будут переигрывать,
# и черновик — единственная запись остатка работы. Приёмочный прогон t8165: TESTS отчитался
# «детали и остаток — t8165.tests.checkpoint.md», а движок стёр файл следующей же строкой.
runtime_src=$(cat "$FACTORY_HOME/lib/route-runtime-v2.sh")
assert_contains "$runtime_src" '[[ "$outcome" != failed && "$outcome" != exhausted ]]' \
  "route v2 не снимает черновик на провале и исчерпании попыток"
core_src=$(cat "$FACTORY_HOME/lib/core.sh")
assert_contains "$core_src" 'failed) flog "$t" "$key → failed"; return 1 ;;' \
  "легаси-путь тоже оставляет черновик провалившегося этапа"

# --- указание человека при возврате курсора ---
# Свободный текст от человека доезжал до агента только через решения ворот; у обычного
# узла канала не было, и на t8165 разбор пришлось протаскивать через черновик — мимо
# журнала попытки. Блок идёт ПОСЛЕДНИМ: черновик выше зовёт «продолжай с этого места»,
# а человек мог вернуть узел ровно затем, чтобы с этого места свернуть.
rm -f "$ckpt"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
case "$(cat "$TEST_ROOT/prompt")" in
  *'Указание человека'*) test_fail "без возврата блока указания нет" "блок найден" ;;
  *) test_ok "без возврата блока указания нет" ;;
esac

human_note='сначала докажи, что колонка есть, и только потом красный тест'
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_HUMAN_NOTE="$human_note" \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'Указание человека при возврате на этот узел' \
  "указание объявлено отдельным блоком"
assert_contains "$prompt" "$human_note" "текст указания передан дословно"
assert_contains "$prompt" 'прав человек' "названо, чьё слово главнее при расхождении"
assert_contains "$prompt" 'сделай работу' "задание узла не вытеснено указанием"

# Порядок важен: указание должно стоять ПОСЛЕ черновика, иначе последнее слово в промпте
# остаётся за инструкцией «продолжай с этого места», которую человек и пришёл отменить.
printf 'сделан парсер, лежит в src/parse.ts\n' >"$ckpt"
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_HUMAN_NOTE="$human_note" \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'Черновик незакрытого захода' "черновик остаётся на месте"
before=${prompt%%Указание человека при возврате*}
case "$before" in
  *'Черновик незакрытого захода'*) test_ok "указание идёт после черновика" ;;
  *) test_fail "указание идёт после черновика" "указание оказалось выше черновика" ;;
esac
rm -f "$ckpt"

finish_tests
