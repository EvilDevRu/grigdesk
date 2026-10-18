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

# --- сроки названы и часами машины: минуты «с начала этапа» агенту отсчитать нечем ---
# t7989: три захода по 30 минут, каждый убит перед stage-result — третий записал артефакт
# за 50 секунд до обрыва. Минуты в регламенте были, часов у агента не было.
clock_epoch=1790000000
clock_block=$(_stage_time_budget_block 3600 "$STATE_DIR/t41.build.checkpoint.md" "$clock_epoch")
assert_contains "$clock_block" "старт в $(date -d "@$clock_epoch" +%H:%M)" \
  "регламент называет время старта по часам машины"
assert_contains "$clock_block" "обрыв в **$(date -d "@$(( clock_epoch + 3600 ))" +%H:%M)**" \
  "регламент называет время обрыва: старт плюс жёсткий предел"
assert_contains "$clock_block" "**48 мин** ($(date -d "@$(( clock_epoch + 2880 ))" +%H:%M))" \
  "мягкий срок назван и минутами, и часами"
assert_contains "$clock_block" 'date +%H:%M' "агенту сказано, чем сверять часы"
assert_contains "$prompt" 'обрыв в **' "в бою часы подставляются от текущего времени"

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

# У цикла другая политика ремонта: живой служебный блок доезжает и до попытки
# со старым закреплённым промптом, не отменяя исходные критерии задачи.
for loop_role in lead worker; do
  FACTORY_LOOP_ROLE="$loop_role" run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
  loop_prompt=$(cat "$TEST_ROOT/prompt")
  assert_contains "$loop_prompt" 'Повторное замечание возвращай исполнителю' \
    "$loop_role получает право на повторный ремонт"
  assert_contains "$loop_prompt" 'стабильный id сохраняй' \
    "$loop_role сохраняет связь замечания с требованием"
  assert_contains "$loop_prompt" 'каждый ремонт расходует круг' \
    "$loop_role видит действующий предел автономной работы"
  assert_contains "$loop_prompt" 'Область не сужается узлом — только человеком' \
    "$loop_role не получает права отменять критерии"
  [[ "$loop_prompt" != *'runtime зафиксирует `no-progress`'* ]]
  assert_rc 0 "$?" "$loop_role не получает запрета на второй ремонт"
done

# --- самостоятельное решение предъявляется карточкой ---
# Принцип плана автономности: конвейер не встаёт посреди маршрута с вопросом, на который
# человек всё равно не пойдёт смотреть (замер: одна такая остановка — 14 часов простоя
# стенда, вторая — 31 минута человека курьером между тем же ИИ и полем причины). Цена
# права решать самому — карточка в отчёте приёмки: иначе конвейер так же тихо примет
# регресс. Адрес карточки — `artifacts.report`, потому что это и есть отчёт приёмки,
# ворота `gate_accept` показывают именно его, и узлы маршрута уже дописывают туда сводки.
assert_contains "$prompt" 'Решил сам — предъяви карточкой' \
  "каждый этап получает правило карточки"
assert_contains "$prompt" 'artifacts.report' \
  "назван адрес карточки, а не «отчёт» вообще"
assert_contains "$prompt" 'чем грозит ошибка' \
  "карточка требует признак, по которому человек увидит неверное решение"
assert_contains "$prompt" 'читаются без открытия репозитория' \
  "первые четыре пункта адресованы человеку, а не читателю кода"
# Карточка идёт ПОСЛЕ границы scope: сначала «не расширяй задачу и не блокируй по чужому»,
# потом «а что решил сам — предъяви». Обратный порядок читался бы как разрешение решать
# что угодно, лишь бы записать.
scope_at=$(awk '/Замкнутая область задачи/{print NR; exit}' <<<"$prompt")
card_at=$(awk '/Решил сам — предъяви карточкой/{print NR; exit}' <<<"$prompt")
card_order=нет
[[ -n "$scope_at" && -n "$card_at" && "$scope_at" -lt "$card_at" ]] && card_order=да
assert_eq да "$card_order" "карточка идёт после границы scope ($scope_at до $card_at)"
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
# Повтор без результата — закрывающий заход: прежний блок просил «доделать, а не
# переписывать», и агент честно читал черновик, а затем заново поднимал веер ролей по
# требованию промпта узла (t7989: три захода, в каждом три роли с нуля).
assert_contains "$prompt" 'Это закрывающий заход' "повтор без результата объявлен закрывающим"
assert_contains "$prompt" 'Не поднимай заново параллельные роли' \
  "повтору запрещено переигрывать веер ролей даже по требованию промпта узла"
case "$prompt" in
  *'убит по лимиту времени'*) test_fail "без класса исхода повтор не выдумывает таймаут" ;;
  *) test_ok "без класса исхода повтор не выдумывает таймаут" ;;
esac

FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_RETRY=2 FACTORY_STAGE_RETRY_REASON=no-result \
  FACTORY_STAGE_RETRY_NOTE=timeout run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'убит по лимиту времени этапа' \
  "класс исхода timeout назван повтору прямо"

FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_RETRY=3 FACTORY_STAGE_RETRY_REASON=failed \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'Это повтор этапа (заход 3)' "третий заход назван своим номером"
assert_contains "$prompt" 'отказом по существу' "названа причина: отказ по существу"
case "$prompt" in
  *'Это закрывающий заход'*) test_fail "повтор по существу задачи закрывающим не объявляется" ;;
  *) test_ok "повтор по существу задачи закрывающим не объявляется" ;;
esac

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
# 24000 — замер 27.08.2026 (22360 байт: 15076 обвязки + 7284 блока черновика) плюс запас,
# сдвинутый на правило «область не сужается узлом» (см. бюджет обвязки ниже).
# Число В БАЙТАХ: прогон идёт под `LC_ALL=C`, и русская буква стоит двух. Границу поднимали
# трижды и каждый раз за названный механизм: карточку решения, правило опыта проверяющего
# узла и запрет сужения области (см. бюджет обвязки ниже). Черновик от роста обвязки НЕ
# страдает: его хвост фиксированные 6000 байт и не ужимается, растёт только сумма.
assert_eq 0 "$(( ${#prompt} > 24000 ? 1 : 0 ))" "длинный черновик обрезан, а не вставлен целиком"

# --- служебная обвязка промпта имеет БЮДЖЕТ, и он проверяется явно ---
# Блоки движка (регламент области, бюджет времени, повтор, черновик, находки, слово
# человека) вклеиваются в КАЖДЫЙ заход каждого узла и платятся токенами на каждом
# обращении к модели. Расти они умеют только в одну сторону: каждое правило выглядит
# полезным по отдельности. Потолок 20000 выше стережёт обрезку черновика и о служебной
# части ничего не утверждает — он поймал разрастание регламента случайно, одним общим
# числом, и в следующий раз мог не поймать.
#
# Поэтому обвязка меряется отдельно и без черновика. 15400 — это замер 27.08.2026
# (15076 БАЙТ, а не символов: `LC_ALL=C`, русская буква стоит двух) плюс небольшой запас,
# а не выведенная величина. Превысил — либо ужимай текст, либо поднимай границу здесь же
# и объясняй, за что платим.
#
# Границу поднимали трижды, и каждый раз цена названа:
#   12500 → 13500 — карточка решения (1001 байт). Механизм принципа «конвейер решает сам
#     и предъявляет решение в приёмке»: без карточки автономия означает молчаливое
#     решение, и защиты от тихо принятого регресса не остаётся вовсе.
#   13500 → 14600 — правило «не смог проверить ≠ блокирующее замечание» и адрес опыта
#     (`stage-probe.sh`, 1098 байт). Оплачено замером: в живом прогоне проверяющий узел
#     пять раз подряд получил отказ прав на проверку формы импорта, вынес неразрешённый
#     вопрос БЛОКИРУЮЩИМ замечанием и остановил маршрут у человека. Правило без адреса
#     опыта было бы половиной механизма: узлу говорят «не блокируй», не давая проверить.
#   14600 → 15400 — правило «грязное дерево не находка и не твоя работа» (754 байта).
#     Оплачено прогоном: проверяющий узел увидел в `git status` env-файл, изменённый
#     ПОДЪЁМОМ песочницы, счёл это мусором и вернул файл к базовой ветке — снёс схемы
#     задачи и адрес Redis, без которого тесты в контейнере не работают. Сторож остановил
#     маршрут за шаг до приёмки. Отличить своё от чужого по `git status` узел не может в
#     принципе: снимок ДО захода есть только у движка, поэтому правило запрещает саму
#     попытку, а не учит её делать правильно.
#   15400 → 16700 — правило «область не сужается узлом — только человеком» (1130 байт).
#     Оплачено прогоном лёгкого маршрута: критерии приёмки были пусты, разведка объявила
#     пункт постановки «уже реализованным», сборка отбросила его «карточкой решения»,
#     ревью отложило дыру как «решение владельца» — и на приёмку уехала треть задачи без
#     единого вопроса человеку. Граница области до этого ловила только расширение.
#   16700 → 17000 — часы машины в регламенте времени (265 байт). Оплачено t7989: три
#     захода узла плана по 30 минут, каждый убит перед stage-result, третий записал
#     артефакт за 50 секунд до обрыва. Минуты «с начала этапа» в регламенте были, но
#     отсчитать их агенту нечем; абсолютное время сверяется одной командой `date`.
: >"$ckpt"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'x' BUILD >/dev/null 2>&1
overhead=$(( $(wc -m <"$TEST_ROOT/prompt") - 1 ))
assert_eq 0 "$(( overhead > 17000 ? 1 : 0 ))"   "служебная обвязка промпта укладывается в бюджет (сейчас $overhead из 17000)"

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
# поэтому отдельная настройка позволяет раньше ограничить рабочий контекст. Это не тарифная
# граница: переиспользование prompt cache проверяется только по фактическим read/write.
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_AUTO_COMPACT=120000 \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_eq 120000 "$(cat "$TEST_ROOT/autocompact")" "порог из GrigDesk доезжает до раннера"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_eq 0 "$(cat "$TEST_ROOT/autocompact")" "без настройки порога раннер не вмешивается"
printf 'AUTO_COMPACT_WINDOW=90000\n' >>"$FACTORY_PROFILES_DIR/fixture/runners.env"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_eq 90000 "$(cat "$TEST_ROOT/autocompact")" "без GrigDesk порог берётся из runners.env"
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_AUTO_COMPACT=200000 \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_eq 200000 "$(cat "$TEST_ROOT/autocompact")" "GrigDesk сильнее профиля"
FACTORY_ROUTE_TIMEOUT_CLASS=build FACTORY_STAGE_AUTO_COMPACT=нет \
  run_agent 41 'сделай работу' BUILD >/dev/null 2>&1
assert_eq 0 "$(cat "$TEST_ROOT/autocompact")" "мусор в пороге читается как «не вмешиваться»"

finish_tests
