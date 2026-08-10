#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

# Лимит этапа и то, что о нём знает агент, обязаны идти из ОДНОГО источника: пока
# число жило только в движке, агент планировал проверки вслепую и мог быть убит
# перед отчётом — вместе с готовым кодом, который движок не засчитал.

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
  # Порог автосжатия движок отдаёт раннеру отдельной переменной, поэтому фиксируем ровно
  # то, что раннер увидел: остаток входной переменной в оболочке доказывал бы не то.
  printf '%s' "${RUNNER_AUTO_COMPACT_WINDOW-нет}" >"$TEST_ROOT/autocompact"
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

# --- узел без класса получает единый консервативный default ---
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

# --- регламент доезжает до агента и совпадает с фактическим лимитом ---
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'сделай работу' "исходное задание узла не потеряно"
assert_contains "$prompt" '**60 мин**' "агенту назван жёсткий предел"
assert_contains "$prompt" '**48 мин**' "агенту назван срок фиксации результата"
assert_contains "$prompt" 'stage-result' "агенту названо, чем фиксировать"

# --- scope замкнут движком, а не меняющимися профильными промптами ---
# Уже начатая attempt закрепила старый route hash, но живой core собирает служебный хвост
# перед каждым запуском. Поэтому инвариант должен доезжать и до старой попытки без recover.
assert_contains "$prompt" 'Замкнутая область задачи (инвариант движка)' \
  "каждый этап получает границу scope"
assert_contains "$prompt" 'План раскладывает эти требования' \
  "план не объявлен источником новых требований"
assert_contains "$prompt" 'Явный запрет команды и точная команда проверки' \
  "командные ограничения задачи сильнее шаблона этапа"
assert_contains "$prompt" 'Запрещённую команду не запускай даже «для проверки»' \
  "проверочный узел не обходит запрет задачи"
assert_contains "$prompt" 'используй указанную в задаче безопасную замену' \
  "точная безопасная команда задачи получает приоритет"
assert_contains "$prompt" '--finding-deferred' \
  "находка вне критериев получает машинный канал, а не пометку словами"
assert_contains "$prompt" 'блокирует только то, что ломает цель самой задачи' \
  "граница блокирующего названа однозначно"
assert_contains "$prompt" 'этот набор **замкнут**' \
  "повторный критик не открывает новый набор замечаний"
assert_contains "$prompt" 'runtime остановит расширение у человека' \
  "новый blocker не запускает ещё один автоматический rewind"
assert_contains "$prompt" 'переименование или дробление дефекта' \
  "stable finding id нельзя обойти новой формулировкой"
assert_contains "$prompt" 'если после одного ремонта остался тот же набор id' \
  "тот же набор findings получает только один автоматический ремонт"
assert_contains "$prompt" 'закрывай только его открытые замечания' \
  "автор на возврате не расширяет работу"

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
# оркестратора resume входит в узел заново с попыткой №1.
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

# Байтовый потолок может попасть внутрь многобайтного символа. На живой задаче
# tail -c начинал хвост русского checkpoint с continuation-byte, и Codex трижды
# отклонял весь prompt как invalid UTF-8, даже не начиная REVIEW.
{ printf 'Ж'; head -c 5999 /dev/zero | tr '\0' 'x'; } >"$ckpt"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
if python3 - "$TEST_ROOT/prompt" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).read_bytes().decode("utf-8")
PY
then
  test_ok "обрезанный внутри многобайтного символа черновик не портит UTF-8 промпта"
else
  test_fail "обрезанный внутри многобайтного символа черновик не портит UTF-8 промпта" \
    "prompt содержит недопустимую UTF-8 последовательность"
fi

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

# Кто именно трогает черновик — политика вызывающего, а не примитива. Терминально закрытый
# узел его ПОДПИСЫВАЕТ: критик отклоняет штатно, маршрут возвращает курсор сюда же, и без
# подписанных заметок второй заход получает промпт, побайтово равный первому, — то есть
# заново выводит разведку, которую уже проводил. Провал узла подписи не получает вовсе: он
# ничем не закончился, и заходу об этом надо сказать прямо. Если TESTS отчитается «детали и
# остаток — t<TASK>.tests.checkpoint.md», движок не должен стирать файл следующей же строкой.
runtime_src=$(cat "$FACTORY_HOME/lib/route-runtime.sh")
assert_contains "$runtime_src" '[[ "$outcome" != failed && "$outcome" != exhausted ]]' \
  "route runtime не подписывает черновик на провале и исчерпании попыток"
assert_contains "$runtime_src" '_stage_checkpoint_seal "$task" "$run_key" "$outcome"' \
  "терминальный исход подписывает черновик, а не стирает его"
case "$runtime_src" in
  *'_stage_checkpoint_clear '*)
    test_fail "route runtime черновик закрытого узла не удаляет" "остался вызов clear" ;;
  *) test_ok "route runtime черновик закрытого узла не удаляет" ;;
esac

# Подпись: исход и время стоят в самом файле — иначе следующий заход не отличит обломки
# оборванного хода от завёрнутой дальше по маршруту работы.
printf 'красный тест лежит в tests/server/a.test.js\n' >"$ckpt"
_stage_checkpoint_seal 41 BUILD done
assert_file_exists "$ckpt" "подпись черновик не уносит"
sealed=$(cat "$ckpt")
assert_contains "$sealed" 'красный тест лежит в tests/server/a.test.js' "прежние заметки целы"
assert_contains "$sealed" 'ЗАХОД ЗАКРЫТ: исход `done`' "в файле назван исход захода"
printf 'жертва\n' >"$TEST_ROOT/victim"
rm -f "$ckpt"; ln -s "$TEST_ROOT/victim" "$ckpt"
_stage_checkpoint_seal 41 BUILD done
assert_eq 'жертва' "$(cat "$TEST_ROOT/victim")" "по symlink подпись в чужой файл не пишет"
rm -f "$ckpt"

# Подписанный черновик приезжает другим блоком: заход обязан знать, что перед ним не
# обломки, а сделанная работа, которую не приняли.
{ printf 'красный тест: tests/server/a.test.js, падает по причине X\n'
  printf -- '---\nЗАХОД ЗАКРЫТ: исход `done`, 2026-08-08 10:00 UTC\n'; } >"$ckpt"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'Заметки предыдущих заходов этого этапа' \
  "у подписанного черновика свой заголовок"
assert_contains "$prompt" 'результат не приняли' "заходу названа причина, по которой он здесь"
assert_contains "$prompt" 'падает по причине X' "заметки прошлого захода переданы дословно"
case "$prompt" in
  *'Черновик незакрытого захода'*)
    test_fail "подписанный черновик не выдаётся за обрыв" "заголовок обрыва найден" ;;
  *) test_ok "подписанный черновик не выдаётся за обрыв" ;;
esac
rm -f "$ckpt"

# Граница памяти — ПОПЫТКА: заново запущенный прогон не наследует заметки брошенного.
printf 'заметки прошлой попытки\n' >"$ckpt"
printf 'заметки прошлой попытки\n' >"$(_stage_checkpoint_path 41 TESTS)"
printf 'чужая задача\n' >"$STATE_DIR/t4.build.checkpoint.md"
_stage_checkpoint_clear_task 41
assert_file_missing "$ckpt" "новая попытка снимает черновики задачи"
assert_file_missing "$(_stage_checkpoint_path 41 TESTS)" "снимаются черновики всех этапов задачи"
assert_file_exists "$STATE_DIR/t4.build.checkpoint.md" "черновик соседней задачи не задет"
rm -f "$STATE_DIR/t4.build.checkpoint.md"
factory_src=$(cat "$FACTORY_HOME/bin/factory")
assert_contains "$factory_src" '_stage_checkpoint_clear_task "$TASK"' \
  "чистка черновиков стоит на создании новой попытки"

# --- указание человека при возврате курсора ---
# Свободный текст от человека доезжал до агента только через решения ворот; у обычного
# узла канала не было, и разбор приходилось протаскивать через черновик — мимо
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
case "$before" in
  *'Замкнутая область задачи (инвариант движка)'*)
    test_ok "слово человека остаётся ниже границы scope" ;;
  *) test_fail "слово человека остаётся ниже границы scope" \
       "указание оказалось выше scope-блока" ;;
esac
rm -f "$ckpt"

# --- карта задачи от разведки ---
# Заход из N раундов оплачивается квадратично: модель не помнит предыдущий запрос, и
# каждый следующий заново везёт весь накопленный контекст. Половина раундов уходила на
# выяснение, ГДЕ лежит то, что разведка уже нашла и записала. Единственный канал до всех
# этапов — движок: маршрут прибит хешем на старте попытки, а промпты этапов принадлежат
# схемам и правятся по профилям.
recon=$(_stage_task_map_path 41)
assert_eq "$STATE_DIR/t41.recon.md" "$recon" "адрес карты детерминирован по задаче"

rm -f "$recon"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
case "$(cat "$TEST_ROOT/prompt")" in
  *'Карта задачи'*) test_fail "без файла разведки блока карты нет" "блок найден" ;;
  *) test_ok "без файла разведки блока карты нет" ;;
esac

# Файл есть, но нужного раздела в нём нет — блок не выдумывается.
printf '# Разведка\n\n## Риски\n\n- миграция необратима\n' >"$recon"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
case "$(cat "$TEST_ROOT/prompt")" in
  *'## Карта задачи (от движка'*)
    test_fail "без раздела карты блока нет" "блок собран из чужого раздела" ;;
  *) test_ok "без раздела карты блока нет" ;;
esac

cat >"$recon" <<'RECON'
# Разведка

## Область изменения

- server/src/modules/chat/index.js — приём хода
- web/src/views/chat/StepList.vue — лента шагов

## Риски

- SSE переживает рестарт
RECON
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
# Fallback на «Область изменения» — то, что recon.md писал ДО введения карты. Без него
# шаг «только движок» требовал бы публикации каталога во всех профилях сразу.
assert_contains "$prompt" '## Карта задачи (от движка' "старый раздел разведки работает как карта"
assert_contains "$prompt" 'server/src/modules/chat/index.js' "файлы из карты доехали дословно"
case "$prompt" in
  *'SSE переживает рестарт'*)
    test_fail "соседний раздел разведки не подмешивается" "в промпт уехали риски" ;;
  *) test_ok "соседний раздел разведки не подмешивается" ;;
esac
assert_contains "$prompt" 'сделай работу' "задание узла не вытеснено картой"

# Явная карта сильнее старого раздела: разведка, научившаяся её писать, не должна
# конкурировать сама с собой.
cat >"$recon" <<'RECON'
# Разведка

## Карта задачи

- engine/lib/core.sh — сборка промпта; ключевые места: run_agent

### Подробности

- потолок блока считает python3

## Область изменения

- старый раздел
RECON
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'engine/lib/core.sh — сборка промпта' "карта берётся из своего раздела"
assert_contains "$prompt" 'потолок блока считает python3' "вложенный подзаголовок остаётся в карте"
case "$prompt" in
  *'старый раздел'*) test_fail "при своей карте старый раздел не берётся" "уехали оба" ;;
  *) test_ok "при своей карте старый раздел не берётся" ;;
esac

# Правило поведения живёт в блоке движка, а не в промптах этапов: копии по профилям
# разъедутся на первой же правке формулировки.
assert_contains "$prompt" 'открывай его напрямую' "агенту сказано не искать названное"
assert_contains "$prompt" "$recon" "агенту назван адрес, куда дописывать найденное"

# Потолок: карта в K токенов едет в КАЖДОМ раунде захода, поэтому объём ограничен.
# Режется КОНЕЦ (в отличие от черновика, где ценен хвост) и об обрезке сказано прямо.
{
  printf '## Карта задачи\n\n'
  for i in $(seq 1 900); do
    printf -- '- src/очень/длинный/путь/файл-%s.ts — роль %s\n' "$i" "$i"
  done
} >"$recon"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'файл-1.ts' "у обрезанной карты сохранено начало"
assert_contains "$prompt" 'карта обрезана движком' "обрезка названа, а не скрыта"
case "$prompt" in
  *'файл-900.ts'*) test_fail "длинная карта обрезана, а не вставлена целиком" "уехал хвост" ;;
  *) test_ok "длинная карта обрезана, а не вставлена целиком" ;;
esac
if LC_ALL=C.UTF-8 python3 -c 'import sys; sys.stdin.buffer.read().decode("utf-8")' \
     <"$TEST_ROOT/prompt" 2>/dev/null; then
  test_ok "обрезанная по границе многобайтного символа карта не портит UTF-8 промпта"
else
  test_fail "обрезанная по границе многобайтного символа карта не портит UTF-8 промпта" \
    "промпт перестал быть валидным UTF-8"
fi

# Карта — справочник, а не указание заходу: хвост промпта принадлежит тому, что направляет
# ход. Проверяем оба конца — регламент ниже карты, слово человека остаётся последним.
before=${prompt%%Регламент времени этапа*}
case "$before" in
  *'## Карта задачи (от движка'*) test_ok "карта идёт перед регламентом времени" ;;
  *) test_fail "карта идёт перед регламентом времени" "карта оказалась ниже регламента" ;;
esac
before_scope=${prompt%%Замкнутая область задачи*}
case "$before_scope" in
  *'## Карта задачи (от движка'*) test_ok "карта идёт перед границей scope" ;;
  *) test_fail "карта идёт перед границей scope" "scope оказался выше справочной карты" ;;
esac
assert_contains "$before" 'Замкнутая область задачи' \
  "граница scope идёт перед регламентом времени"
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_HUMAN_NOTE="$human_note" \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
before=${prompt%%Указание человека при возврате*}
case "$before" in
  *'## Карта задачи (от движка'*) test_ok "слово человека остаётся ниже карты" ;;
  *) test_fail "слово человека остаётся ниже карты" "указание оказалось выше карты" ;;
esac

# Карта чужой задачи не подмешивается: имя файла задаётся номером задачи.
printf '## Карта задачи\n\n- чужой/файл.ts — чужая роль\n' >"$STATE_DIR/t99.recon.md"
rm -f "$recon"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
case "$(cat "$TEST_ROOT/prompt")" in
  *'чужой/файл.ts'*) test_fail "карта чужой задачи не подмешивается" "уехала чужая карта" ;;
  *) test_ok "карта чужой задачи не подмешивается" ;;
esac
rm -f "$STATE_DIR/t99.recon.md"

# --- предел раундов: порог сведения, а не остановка ---
# Молча брошенный заход движок считает «результата нет» и списывает попытку из бюджета
# этапа, поэтому счётчик не имеет права звучать как «останавливайся».
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" '**150 вызовов инструментов**' "агенту назван предел раундов"
assert_contains "$prompt" 'сведи сделанное в черновик' "предел сформулирован как сведение"
assert_contains "$prompt" 'Бросить заход молча нельзя' "названа цена брошенного захода"
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_ROUND_BUDGET=40 \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_contains "$(cat "$TEST_ROOT/prompt")" '**40 вызовов инструментов**' \
  "предел раундов переопределяется движком"
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_ROUND_BUDGET=abc \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_contains "$(cat "$TEST_ROOT/prompt")" '**150 вызовов инструментов**' \
  "мусор в пределе раундов не доезжает до агента"

# --- порог автосжатия контекста этапа ---
# Собственный порог CLI — доля ОКНА модели: при окне в миллион он срабатывает около 959k,
# то есть в дорогой зоне (выше ~250k кэш промпта перестаёт совпадать) не включается никогда.
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_AUTO_COMPACT=120000 \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_eq 120000 "$(cat "$TEST_ROOT/autocompact")" "порог из кокпита доезжает до раннера"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_eq 0 "$(cat "$TEST_ROOT/autocompact")" "без настройки порога раннер не вмешивается"
printf 'AUTO_COMPACT_WINDOW=90000\n' >>"$FACTORY_PROFILES_DIR/fixture/runners.env"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_eq 90000 "$(cat "$TEST_ROOT/autocompact")" "без кокпита порог берётся из runners.env"
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_AUTO_COMPACT=200000 \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_eq 200000 "$(cat "$TEST_ROOT/autocompact")" "кокпит сильнее профиля"
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_AUTO_COMPACT=нет \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_eq 0 "$(cat "$TEST_ROOT/autocompact")" "мусор в пороге читается как «не вмешиваться»"

finish_tests
