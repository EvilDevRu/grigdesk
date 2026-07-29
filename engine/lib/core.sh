#!/usr/bin/env bash
# Ядро движка фабрики — AGNOSTIC. Не знает о проектах: всё проектное берётся из профиля
# (см. ../docs/engine/PROFILE-CONTRACT.md). Здесь: реестр статусов, ворота, resume-цикл, flock, таймауты.
# Подключается из bin/factory. Требует, чтобы профиль уже был подгружен (source).

FACTORY_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${STATE_DIR:-$HOME/.factory/state}"
LOGDIR="$STATE_DIR/logs"; mkdir -p "$LOGDIR" "$STATE_DIR/archive"
NODE_TIMEOUT="${FACTORY_STAGE_TIMEOUT:-1800}"   # таймаут одного этапа (сек)
# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/multi-runner.sh"

# --- реестр статусов (единственный способ менять) ---
_pf() { echo "$STATE_DIR/t${1}.pipeline"; }
set_st() { local t=$1; shift; STATE_DIR="$STATE_DIR" bash "$FACTORY_HOME/lib/pipeline-set.sh" "$t" "$@" >/dev/null; }
get() { grep "^$2=" "$(_pf "$1")" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
set_stage_terminal() {
  local t=$1 stage=$2 result=$3; shift 3
  run_state_control_update "$t" "$stage" "$result" "$@"
}
# Пишем ТОЛЬКО в файл: stdout демона и так перенаправлен в этот же журнал (bin/factory),
# поэтому tee давал каждую строку дважды и журнал читался как «всё случилось два раза».
flog() { echo "$(date '+%F %T') [t${1}] ${*:2}" >>"$LOGDIR/t${1}.stages.log"; }

# --- разрешения агента (слой ПОВЕРХ личных настроек пользователя, не вместо них) ---
# Мало дать доступ к каталогам: статус этапа выставляется КОМАНДОЙ, а bash-команды одобряются
# отдельно от правок файлов. Без этого агент доходит до последнего шага и просит разрешение —
# в неинтерактивном режиме это значит «этап не завершён» и повтор с нуля (инцидент t8060).
# Профиль может добавить свои команды через массив PROFILE_AGENT_ALLOW (например прогон тестов).
_agent_settings() {
  local stage=${1:-}
  local f="$STATE_DIR/agent-settings-${stage:-any}.json" rules extra=""
  if declare -p PROFILE_AGENT_ALLOW >/dev/null 2>&1; then
    local r
    for r in "${PROFILE_AGENT_ALLOW[@]}"; do extra+=",\"$r\""; done
  fi
  # Базовый набор: без него этап не может ни осмотреться, ни записать свой отчёт. В #8060
  # насчитано 278 отказов за прогон (267 Bash + 10 Write, среди них — запись t8060.recon.md
  # в каталог самой фабрики). Отказ в неинтерактивном режиме не виден: агент молча перебирает
  # формулировки команды, тратит минуты и деньги, а отчёт этапа не появляется вовсе.
  # Опасное (автоформатирование) режется отдельно, в deny ниже — оно сильнее allow.
  local base='"Write('"$STATE_DIR"'/**)","Edit('"$STATE_DIR"'/**)","Read(//**)"'
  base+=',"Bash(git:*)","Bash(git -C:*)","Bash(grep:*)","Bash(rg:*)","Bash(ls:*)","Bash(cat:*)"'
  base+=',"Bash(head:*)","Bash(tail:*)","Bash(wc:*)","Bash(find:*)","Bash(sed:*)","Bash(awk:*)"'
  base+=',"Bash(docker exec:*)","Bash(docker compose exec:*)","Bash(php:*)","Bash(node:*)"'
  base+=',"Bash(npx eslint:*)","Bash(npx vue-tsc:*)","Bash(npm run:*)","Bash(curl:*)","Bash(python3:*)"'
  rules="\"Bash(bash $FACTORY_HOME/lib/stage-result.sh:*)\",\"Bash($FACTORY_HOME/lib/stage-result.sh:*)\""
  rules+=",\"Bash(bash $FACTORY_HOME/lib/stage-progress.sh:*)\",\"Bash($FACTORY_HOME/lib/stage-progress.sh:*)\""
  rules+=",$base$extra"
  # Запреты — второй рубеж после проверки диффа: команды автоформатирования не должны даже
  # запускаться. Профиль добавляет свои через PROFILE_AGENT_DENY.
  local deny='"Bash(npx eslint --fix:*)","Bash(eslint --fix:*)","Bash(npm run lint:fix:*)","Bash(yarn lint --fix:*)","Bash(pnpm lint --fix:*)","Bash(npx prettier --write:*)","Bash(prettier --write:*)"'
  if declare -p PROFILE_AGENT_DENY >/dev/null 2>&1; then
    local r
    for r in "${PROFILE_AGENT_DENY[@]}"; do deny+=",\"$r\""; done
  fi
  # ГЛАВНЫЙ рубеж для проверочных этапов: запрет ПИСАТЬ в каталоги проекта вообще.
  # Списка команд мало — он ловит «eslint --fix», но не «eslint . --fix» и не правку файла
  # редактором напрямую. Линт дважды (21.07 и 22.07) переформатировал 278-280 чужих файлов
  # в ветке задачи, хотя запрет в промпте стоял: просьба не работает, работает отсутствие прав.
  if [[ -n "$stage" ]] && declare -F profile_stage_readonly >/dev/null \
     && [[ -n "$(profile_stage_readonly "$stage" 2>/dev/null)" ]]; then
    local d
    for d in ${PROFILE_AGENT_DIRS:-}; do
      deny+=",\"Edit(${d}/**)\",\"Write(${d}/**)\",\"NotebookEdit(${d}/**)\""
    done
    # ЗАПРЕТА Edit/Write МАЛО: базовый allow выше открывает bash, а через bash файл
    # правится в обход прав на редактирование. Так и вышло 27.07: LINT #7795 переписал
    # комментарий через `sed -i`, следом унёс файл задачи в `git stash`; LINT #7804
    # раскидал файл по контейнерам через `docker cp` и перемонтировал основной стенд.
    # Каждый раз сторож проверочных этапов валил этап и сбрасывал ВЕСЬ хвост от сборки
    # заново — по 40 минут на круг, и конвейер выглядел стоящим.
    #
    # Закрываем ходовые вектора. Стеной это не является и не может: `docker exec … pint`
    # (без --test) или `php -r` с записью правилами не выражаются — префиксная маска не
    # умеет заглядывать в середину команды. Настоящий рубеж — механический сторож
    # (_guard_readonly ниже), который сверяет список изменённых файлов до и после этапа.
    # Здесь мы лишь убираем то, за что агент хватается первым делом.
    deny+=',"Bash(sed -i:*)","Bash(perl -i:*)","Bash(tee:*)","Bash(truncate:*)","Bash(dd:*)"'
    deny+=',"Bash(cp:*)","Bash(mv:*)","Bash(rm:*)","Bash(docker cp:*)"'
    deny+=',"Bash(git checkout:*)","Bash(git restore:*)","Bash(git stash:*)","Bash(git reset:*)"'
    deny+=',"Bash(git clean:*)","Bash(git apply:*)","Bash(git rm:*)","Bash(git mv:*)"'
    deny+=',"Bash(git add:*)","Bash(git commit:*)"'
    # Инлайн-интерпретаторы: запуск СКРИПТА проверочному этапу нужен, однострочник с
    # записью — нет. Форма `-e/-r/-c` отсекается, `node script.mjs` остаётся рабочим.
    deny+=',"Bash(node -e:*)","Bash(php -r:*)","Bash(python3 -c:*)"'
    # Скрипты-обёртки package.json: что внутри — знает только сам package.json. В #7800
    # `npm run lint` фронта оказался объявлен как `eslint . --fix`, и автофикс переписал
    # 276 чужих файлов, хотя флага --fix в команде агента не было и запрет на него стоял
    # и в промпте, и в deny. Проверочный этап зовёт линтер НАПРЯМУЮ (npx eslint --no-fix,
    # pint --test) — тогда команда видна целиком и правилами выражается. Прочие npm-скрипты
    # (сборка, e2e) не трогаем: режем только класс lint/format/fix.
    deny+=',"Bash(npm run lint)","Bash(npm run lint:*)","Bash(npm run format:*)","Bash(npm run fix:*)"'
    deny+=',"Bash(yarn lint:*)","Bash(pnpm lint:*)","Bash(npm exec eslint:*)"'
  fi
  printf '{"permissions":{"allow":[%s],"deny":[%s]}}' "$rules" "$deny" > "$f"
  echo "$f"
}

# --- один синхронный прогон агента для этапа ---
# $1=TASK $2=промпт. Выбранный runner делает ОДИН этап и завершается; bash ждёт.
run_agent() {
  local t=$1 prompt=$2 stage=${3:-}
  [[ -n "$stage" ]] || return 2
  # Рабочий каталог — WORKTREE ЗАДАЧИ, если профиль умеет его назвать. Пока cwd был общим
  # репозиторием, агенты складывали туда скриншоты, правили код и запускали eslint --fix
  # по всему проекту: 48 изменённых файлов в бэкенде и 277 во фронте основного стенда.
  local cwd="${PROFILE_AGENT_CWD:-$HOME}"
  if declare -F profile_agent_cwd >/dev/null; then
    local c2; c2=$(profile_agent_cwd "$t" 2>/dev/null)
    [[ -n "$c2" && -d "$c2" ]] && cwd="$c2"
  fi
  cd "$cwd" 2>/dev/null || true
  # --add-dir ОБЯЗАТЕЛЕН: агент работает в каталоге проекта, а реестр/план/отчёты фабрики лежат
  # в STATE_DIR за его пределами. Без этого песочница режет запись, и агент, отработав десятки
  # минут, не может выставить статус этапа — движок считает этап незавершённым и гоняет его заново
  # (инцидент t8060: 19 минут и $4.65 в мусор на каждой попытке).
  # FACTORY_HOME нужен для run-scoped stage-result/stage-progress и служебных команд движка.
  # Лимит времени этапа: браузерные замеры и прогон сценариев идут дольше правки кода.
  # Убитый по таймауту агент теряет ВСЮ работу этапа, поэтому профиль может поднять лимит.
  local tmo="$NODE_TIMEOUT" t2=""
  if declare -F profile_stage_timeout >/dev/null && [[ -n "$stage" ]]; then
    t2=$(profile_stage_timeout "$stage" 2>/dev/null)
    [[ "$t2" =~ ^[0-9]+$ ]] && tmo="$t2"
  fi
  export RUNNER_CLAUDE_SETTINGS
  RUNNER_CLAUDE_SETTINGS=$(_agent_settings "$stage")
  export RUNNER_CLAUDE_ADD_DIRS="$STATE_DIR ${PROFILE_AGENT_DIRS:-}"
  export RUNNER_CODEX_ADD_DIRS="$STATE_DIR ${PROFILE_AGENT_DIRS:-}"
  multi_runner_run "$t" "$prompt" "$stage" "$tmo"
}

# --- ворота: bash ждёт решения человека (дёшево, без висящего агента) ---
# $1=TASK $2=ключ; echo approved|rejected|skipped
# Результат — в GATE_DECISION, НЕ через echo/$(...): command substitution уводит
# ожидание в сабшелл, а родитель блокируется чтением пайпа — и TERM-trap демона
# не срабатывает, пока ворота ждут (демона на воротах было не остановить).
gate_wait() {
  local t=$1 key=$2 cur
  cur=$(get "$t" "$key")
  case "$cur" in approved|rejected|skipped) GATE_DECISION=$cur; return 0 ;; esac   # уже решено (resume)
  set_st "$t" "$key" waiting
  flog "$t" "ВОРОТА $key — жду человека (дашборд)"
  while true; do
    cur=$(get "$t" "$key")
    case "$cur" in approved|rejected|skipped) GATE_DECISION=$cur; return 0 ;; esac
    sleep 10
  done
}

# --- общий протокол-обёртка вокруг проектного промпта этапа ---
_stage_ctx() {
  local t=$1 stage=$2 body fan="" status_contract
  body=$(profile_stage_prompt "$t" "$stage")
  # Веер субагентов. Мягкая формулировка «можно через субагентов» агентом игнорируется:
  # в задаче #8060 разведка ни разу не запустила ни одного, читая файлы 19 минут подряд.
  # Поэтому требование ставим отдельным блоком и перечисляем зоны поимённо.
  if declare -F profile_stage_fanout >/dev/null; then
    fan=$(profile_stage_fanout "$stage" 2>/dev/null)
  fi
  local budget=""
  if declare -F profile_stage_budget >/dev/null; then
    budget=$(profile_stage_budget "$stage" 2>/dev/null)
  fi
  if [[ "$budget" =~ ^[0-9]+$ ]]; then
    # Агент не догадывается, что от него ждут короткого этапа: без ориентира он копает вглубь,
    # пока не упрётся в таймаут. Ориентир + правило «сужай охват, а не работай дольше».
    budget="
БЮДЖЕТ ВРЕМЕНИ: ${budget} мин. Это ориентир, а не жёсткий лимит, но он определяет ГЛУБИНУ:
работай широко и неглубоко, бери самое существенное. Видишь, что не укладываешься — СУЖАЙ охват
и отчитывайся тем, что есть, а не продолжай копать. Не перечитывай то, что уже собрано на
прошлых этапах — читай их файлы.

ОБЯЗАТЕЛЬНО в конце отчёта — раздел «НЕ ПРОВЕРЕНО»: что осталось за кадром из-за бюджета и чем
это грозит. Сокращать охват МОЖНО, скрывать сокращение — НЕЛЬЗЯ: человек на воротах должен видеть,
на что соглашается. «Всё проверено» пиши только если это правда. Если бюджета не хватает, чтобы
сделать этап осмысленно, — так и напиши, это честный результат, а не провал."
  else
    budget=""
  fi
  # Динамический веер: профиль говорит «AUTO min-max», а зоны придумывает сам агент под задачу.
  # Фиксированные зоны хороши, когда состав работы известен заранее; но разведка по разным
  # тикетам затрагивает разные области, и делить её лучше по факту, а не по шаблону.
  if [[ "$fan" == AUTO* ]]; then
    local rng; rng=$(awk '{print $2}' <<<"${fan%%$'\n'*}"); rng=${rng:-4-10}
    local hint; hint=$(tail -n +2 <<<"$fan")
    fan="
РАЗДЕЛИ РАБОТУ САМ И РАСПАРАЛЛЕЛЬ (это обязательная часть этапа):
1) Сначала БЫСТРО, без чтения файлов целиком (grep/ls/поиск по именам), составь карту: какие
   области кода реально затрагивает задача. На это — минуты, а не половина бюджета.
2) Разбей карту на ${rng} НЕЗАВИСИМЫХ зон: одна зона = один субагент, зоны не должны
   пересекаться, иначе двое читают одно и то же и платим дважды. Больше верхней границы не бери:
   отчёты всё равно сводить тебе, и на десятках отчётов ты начнёшь терять детали — это потеря
   качества, а не выигрыш скорости.
3) Запусти ВСЕХ субагентов ОДНИМ сообщением (иначе они пойдут по очереди и смысла нет).
   Каждому: что искать, где искать, что вернуть.
4) Сам код по розданным зонам НЕ читай — твоя работа карта, раздача и сводка.
5) СВЕСТИ — не значит склеить: назови СВЯЗИ между зонами (что на одной стороне ломает другую),
   разбери ПРОТИВОРЕЧИЯ в отчётах (кто прав, а не оба), укажи ПРОБЕЛЫ (ничья зона, её не видел никто).
${hint}"
  elif [[ -n "$fan" ]]; then
    local n; n=$(grep -c . <<<"$fan")
    fan="
ОБЯЗАТЕЛЬНО РАСПАРАЛЛЕЛЬ: запусти РОВНО ${n} Task-субагентов ОДНИМ сообщением (все вызовы в одном
ответе — иначе они пойдут по очереди и смысла нет). Зоны, по одной на субагента:
${fan}
Сам код по этим зонам НЕ читай: твоя работа — раздать задания, дождаться отчётов и свести их.
СВЕСТИ — не значит склеить: раздельный просмотр зон теряет ровно то, что живёт МЕЖДУ ними.
В сводке обязательно: (1) СВЯЗИ между зонами — что на одной стороне ломает другую;
(2) ПРОТИВОРЕЧИЯ — если субагенты расходятся, разберись, кто прав, а не бери оба варианта;
(3) ПРОБЕЛЫ — чего не увидел никто, потому что это ничья зона."
  fi
  # Решения человека с ворот — исполнителям. Без этого они живут только в переписке с оператором
  # и до агентов не доезжают (как маршрут в #8060): этап делает «как правильнее», а не как решили.
  local decisions=""
  if [[ -s "$STATE_DIR/t${t}.decisions.md" ]]; then
    decisions="

РЕШЕНИЯ ЧЕЛОВЕКА — ОБЯЗАТЕЛЬНЫ К ИСПОЛНЕНИЮ. Они важнее твоих соображений и важнее задания этапа:
если задание расходится с ними — следуй решениям и напиши о расхождении в отчёте. Отменить их
может только человек на воротах.
$(cat "$STATE_DIR/t${t}.decisions.md")"
  fi
  status_contract="ОТЧЁТ О СТАТУСЕ — ОБЯЗАТЕЛЕН. Точные run-scoped команды stage-result
и stage-progress движок добавит непосредственно перед запуском. Только stage-result завершает
этап; fixed status-файлы и terminal-запись через pipeline-set отклоняются."
  cat <<EOF
Ты — агент ОДНОГО этапа фабрики ($stage) для задачи #${t}.
Правило: выполни ТОЛЬКО этот этап СИНХРОННО (сам или через параллельных Task-субагентов —
НЕ запускай фоновый Workflow, он осиротеет).

${status_contract}

ПРОПУСК ЭТАПА БЕЗ ПРИЧИНЫ — САМА ПО СЕБЕ АВАРИЯ. Человек видит на схеме только слово
«пропущен» и не может отличить «нечего было проверять» от «агент не справился и сдался»:
в #7804 обоснование пропуска тестов осталось лежать в семимегабайтном журнале прогона,
а в реестре был голый skipped. Пиши причину так, чтобы её хватило человеку на воротах
приёмки: что именно проверять было нечем и почему («в ветке ноль изменений в коде, который
этот этап проверяет», «правка целиком фронтовая — здешние тесты её не сторожат»).
Если статус ставишь командой — передай причину предусмотренным этой командой аргументом.
Пропуск ОБЯЗАТЕЛЬНОГО для маршрута этапа — крайняя мера: сначала ищи, как выполнить его
по-настоящему, и только если это невозможно — пропускай с объяснением, почему невозможно.
Уроки прошлых задач учитывай, если профиль их дал.

ПРОЕКТ: ${PROFILE_NAME}
${PROFILE_CTX}
${decisions}

ЗАДАНИЕ ЭТАПА:
${body}
${budget}
${fan}
EOF
}

# --- агент упёрся в права/песочницу? (последний result в журнале прогона) ---
# Такой отказ повтором не лечится: агент отработает те же десятки минут и снова не сможет
# записать результат. Лучше сразу позвать человека, чем сжечь три попытки (инцидент t8060).
_denied_by_sandbox() {
  local t=$1
  tail -c 200000 "$LOGDIR/t${t}.orch.log" 2>/dev/null | tr ',' '\n' | tail -80 |
    grep -qiE 'sandbox (блокирует|blocks)|разрешение на запись|permission denied.*(state|factory)|нужно разрешение'
}

# --- перечитать профиль (правки применяются БЕЗ убийства демона) ---
# Профиль — обычный bash-файл с функциями; повторный source переопределяет их в живом процессе.
# Молча пропускаем битый файл: половина правки на диске не должна ронять идущую задачу.
_reload_profile() {
  local profiles_dir=${FACTORY_PROFILES_DIR:-"$(cd "$FACTORY_HOME/.." && pwd)/profiles"}
  local pf="$profiles_dir/${PROFILE_NAME}/profile.sh"
  [[ -f "$pf" ]] || return 0
  if bash -n "$pf" 2>/dev/null; then
    local before="${PROFILE_CTX:0:40}"
    source "$pf" 2>/dev/null || true
    [[ "${PROFILE_CTX:0:40}" != "$before" ]] && flog "$1" "профиль перечитан (правки применены на лету)"
  else
    flog "$1" "профиль сейчас с ошибкой синтаксиса — работаю по прежней версии"
  fi
  return 0
}

# --- контроль побочных правок на проверочных этапах ------------------------------
# Линт с автофиксом переформатировал 277 файлов основного репозитория и 235 файлов в ветке
# задачи. Запрет в тексте промпта агент проигнорировал, поэтому запрет теперь МЕХАНИЧЕСКИЙ:
# профиль объявляет этап проверочным (profile_stage_readonly), ядро снимает список изменённых
# файлов ДО и ПОСЛЕ, и всё, что этап тронул сверх работы задачи, откатывает.
_dirty_snapshot() {
  declare -F profile_dirty_files >/dev/null || return 0
  profile_dirty_files "$1" 2>/dev/null | sort
}

_guard_readonly() {
  local t=$1 key=$2 before=$3
  declare -F profile_stage_readonly >/dev/null || return 0
  [[ -n "$(profile_stage_readonly "$key" 2>/dev/null)" ]] || return 0
  local after; after=$(_dirty_snapshot "$t")
  local extra; extra=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -v '^$' || true)
  [[ -z "$extra" ]] && return 0
  local n; n=$(grep -c . <<<"$extra")
  flog "$t" "$key: этап проверочный, но изменил $n файл(ов) — этап провален, работа человека не тронута"
  printf '%s\n' "$extra" | head -20 | while read -r f; do
    [[ -n "$f" ]] && flog "$t" "  тронул: $f"
  done
  # ОТКАТ ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН. Движок НЕ трогает файлы в рабочих копиях: ошибка в определении
  # «побочных» правок стоила бы потерянной работы. Он лишь фиксирует нарушение и валит этап —
  # решение, что делать с файлами, остаётся за человеком.
  # Включить автооткат осознанно: FACTORY_AUTOREVERT=1 (например, на чистом CI-прогоне).
  if [[ "${FACTORY_AUTOREVERT:-0}" == "1" ]] && declare -F profile_revert_files >/dev/null; then
    flog "$t" "$key: FACTORY_AUTOREVERT=1 — откатываю перечисленные файлы"
    profile_revert_files "$t" "$extra" 2>/dev/null || true
  fi
  return 1
}

# --- запуск этапа с повторами; возврат: 0=done/skipped, 1=failed, 2=нет статуса ---
run_stage() {
  local t=$1 key=$2 tries=0 v
  # Маршрут на входе в этап: если этап его сменит (эскалация trivial → feature),
  # «нет статуса» — это НЕ отказ агента, а сигнал пересобрать цепочку в run_pipeline.
  local route0; route0=$(get "$t" ROUTE)
  while (( tries < 3 )); do
    _reload_profile "$t"        # свежие промпты/модели/бюджеты без перезапуска демона
    local dirty_before; dirty_before=$(_dirty_snapshot "$t")
    # Комментарий прошлого круга гасим на старте: иначе замечание, оставленное этапом
    # в прошлый раз, сойдёт за объяснение нового пропуска. Чужие комментарии не трогаем —
    # BUILD читает REVIEW_COMMENT/GATE_ACCEPT_COMMENT, и они должны его дождаться.
    set_st "$t" "$key" running "${key}_COMMENT" "" "TRY_${key}" "$((tries + 1))"
    flog "$t" "этап $key (попытка $((tries+1)))"
    local t0=$SECONDS
    run_agent "$t" "$(_stage_ctx "$t" "$key")" "$key"
    local arc=$?
    if (( arc == 79 )); then
      flog "$t" "$key: цепочка исполнителей исчерпана — СТОП, нужен человек"
      return 2
    fi
    # 124 = агента убил timeout. Это НЕ «агент не справился»: работа была, но пропала.
    # Различать важно — иначе правишь промпт там, где надо поднять лимит времени этапа.
    (( arc == 124 )) && flog "$t" "$key: агент убит по таймауту — работа этапа потеряна, лимит мал"
    # Прочие ненулевые коды: 130=Ctrl-C, 137=SIGKILL (OOM или kill -9), 143=SIGTERM (перезапуск).
    # Без этой строки в журнале оставалось загадочное «без статуса», и причина терялась.
    if (( arc != 0 && arc != 124 )); then
      local why
      case $arc in
        130) why="прерван (SIGINT)" ;; 137) why="убит (SIGKILL: kill -9 или нехватка памяти)" ;;
        143) why="остановлен (SIGTERM: перезапуск демона)" ;; *) why="код выхода $arc" ;;
      esac
      flog "$t" "$key: агент завершился — $why"
    fi
    # Сколько субагентов агент реально запустил. Если веер объявлен, а их ноль — этап шёл
    # последовательно, и «долго работает» объясняется этим, а не сложностью задачи.
    local dur=$(( (SECONDS - t0 + 30) / 60 ))
    set_st "$t" "DUR_${key}" "$dur"
    local bmin=""
    declare -F profile_stage_budget >/dev/null && bmin=$(profile_stage_budget "$key" 2>/dev/null)
    if [[ "$bmin" =~ ^[0-9]+$ ]] && (( dur > bmin * 2 )); then
      flog "$t" "$key: ${dur} мин при бюджете ${bmin} — этап вдвое дольше ожидаемого"
    fi
    # Инструмент субагентов в журнале называется "Agent" (историческое имя "Task" тоже встречается).
    # Счётчик, знавший только "Task", показывал ноль ВСЕГДА — и врал, что веер не работает.
    local used
    used=$(get "$t" "FANOUT_${key}")
    [[ "$used" =~ ^[0-9]+$ ]] || used=0
    if declare -F profile_stage_fanout >/dev/null && [[ -n "$(profile_stage_fanout "$key" 2>/dev/null)" ]] && (( used == 0 )); then
      flog "$t" "$key: веер объявлен, но субагентов не запущено — этап шёл последовательно"
    fi
    # Проверочный этап не имеет права оставлять правки: откатываем и считаем этап проваленным,
    # иначе «зелёный линт» приезжает на приёмку с чужим переформатированным кодом в диффе.
    if ! _guard_readonly "$t" "$key" "$dirty_before"; then
      set_stage_terminal "$t" "$key" failed "${key}_COMMENT" \
        "этап менял файлы вне задачи — правки откачены"
      # Виноват САМ этап (не та команда проверки), а не сборка: возвращать работу в BUILD
      # бессмысленно — он не может исправить то, чем линт себя завалил. В #7800 так ушло
      # три круга по 35 минут подряд, каждый раз с тем же `npm run lint`. Повторяем сам
      # этап, а исчерпав попытки, цикл ниже позовёт человека. Повтор осмыслен только при
      # автооткате: без него чужие правки останутся в рабочей копии и станут «фоном»
      # для следующего снимка — нарушение просто перестанет быть видимым.
      if [[ "${FACTORY_AUTOREVERT:-0}" == "1" ]]; then
        tries=$((tries+1))
        flog "$t" "$key: повторяю сам этап — сборка тут ни при чём"
        continue
      fi
      return 1
    fi
    v=$(get "$t" "$key")
    # Ловим пропуск без причины: сам факт «объяснить не смог» должен быть
    # виден человеку в реестре, а не теряться между каналами.
    if [[ "$v" == skipped && -z "$(get "$t" "${key}_COMMENT")" ]]; then
      set_st "$t" "${key}_COMMENT" "причина не указана — агент не объяснил пропуск"
      flog "$t" "$key → skipped БЕЗ ПРИЧИНЫ — агент не объяснил, почему этап неприменим"
    fi
    case "$v" in
      done|skipped) flog "$t" "$key → $v"; return 0 ;;
      failed) flog "$t" "$key → failed"; return 1 ;;
      *)
        # Эскалация маршрута: этап сменил ROUTE и штатно вышел без статуса
        # (инструкция ESC в промпте trivial-BUILD). Повторять этап НЕЛЬЗЯ —
        # прогон #7803 так ушёл в сборку feature-маршрута без плана и тестов.
        # Возвращаемся в run_pipeline: он перечитает цепочку нового маршрута.
        if [[ "$(get "$t" ROUTE)" != "$route0" ]]; then
          flog "$t" "$key: этап эскалировал маршрут ($route0 → $(get "$t" ROUTE)) — пересобираю цепочку"
          # Закрепляем маршрут за эскалацией: следующий скаут (resume/replan) его не откатит.
          [[ "$(get "$t" ROUTE_BY)" != human ]] && set_st "$t" ROUTE_BY escalation
          return 2
        fi
        if _denied_by_sandbox "$t"; then
          flog "$t" "$key: агенту не дали записать результат (песочница/права) — СТОП, повтор бесполезен"
          set_st "$t" STALLED_HUMAN 1
          return 2
        fi
        tries=$((tries+1)); flog "$t" "$key без статуса ($v) — повтор" ;;
    esac
  done
  flog "$t" "$key: 3 попытки без результата — СТОП, нужен человек"
  set_stage_terminal "$t" "$key" failed STALLED_HUMAN 1
  return 2
}

# --- главный конвейер (agnostic): читает этапы маршрута из профиля ---
run_pipeline() {
  local t=$1
  # flock: один демон на задачу
  exec 9>"$STATE_DIR/t${t}.orch.lock"
  flock -n 9 || { echo "оркестратор t${t} уже держит лок"; return 0; }
  set_st "$t" ORCH_PID "$$" NEEDS_RUN 0 STALLED_HUMAN 0
  # Демон, умерший молча, выглядит как «фабрика нестабильна». Пишем, каким сигналом и на чём.
  # pkill -P: без него bash ждёт завершения текущего агента (до часа), и запись о причине
  # появлялась с огромной задержкой — со стороны выглядело как «просто умер молча».
  trap 'flog '"$t"' "демон остановлен сигналом TERM (перезапуск или kill)"; pkill -P $$ 2>/dev/null; exit 143' TERM
  trap 'flog '"$t"' "демон прерван (Ctrl-C)"; pkill -P $$ 2>/dev/null; exit 130' INT
  trap 'flog '"$t"' "терминал закрыт (SIGHUP) — работа прервана"; exit 129' HUP
  # Стираем PID, только если в реестре ВСЁ ЕЩЁ наш: умирающий старый демон затирал запись,
  # уже сделанную новым, — дашборд считал живую задачу брошенной, а сторож поднимал дубль.
  trap '[[ "$(get '"$t"' ORCH_PID)" == "$$" ]] && set_st '"$t"' ORCH_PID ""' EXIT

  # --- ПАРАЛЛЕЛЬНО: стенд поднимается в фоне, разведка идёт сразу ---
  local sb_pid=""
  if [[ -z "$(profile_sandbox_exists "$t")" ]]; then
    flog "$t" "поднимаю стенд (фоном)"
    ( profile_sandbox_up "$t" ) & sb_pid=$!
  fi

  # --- РАЗВЕДКА ПЕРВОЙ: один проход по коду, она же выставляет ROUTE ---
  # (раньше роутер читал код, потом скауты читали его повторно — двойная работа)
  if [[ -z "$(get "$t" ROUTE)" ]]; then
    if declare -F profile_route >/dev/null; then
      set_st "$t" ROUTE "$(profile_route "$t")"
    else
      run_stage "$t" SCOUT || flog "$t" "разведка без статуса — маршрут по умолчанию"
    fi
  fi
  local route; route=$(get "$t" ROUTE); [[ -z "$route" ]] && { route=feature; set_st "$t" ROUTE feature; }
  # Маршрут из реестра может не существовать в профиле: старая задача (маршрут с тех пор убрали)
  # или опечатка агента. Молча падать нельзя — ведём полным маршрутом.
  if ! declare -p "PROFILE_ROUTE_STAGES_${route}" >/dev/null 2>&1; then
    flog "$t" "маршрут '$route' профилю неизвестен — веду как feature"
    route=feature; set_st "$t" ROUTE feature
  fi
  flog "$t" "маршрут: $route"

  # --- дождаться стенд: он нужен всем этапам после планирования ---
  if [[ -n "$sb_pid" ]]; then
    flog "$t" "жду стенд (разведка уже сделана)"
    wait "$sb_pid" || { flog "$t" "sandbox_up упал"; set_st "$t" STALLED_HUMAN 1; return 1; }
  fi

  # список этапов маршрута из профиля (перечитывается в цикле — этап может эскалировать маршрут)
  local -n STAGES="PROFILE_ROUTE_STAGES_${route}"

  while true; do
    local done_all=1 key v
    for key in "${STAGES[@]}"; do
      v=$(get "$t" "$key")
      [[ "$v" == "done" || "$v" == "skipped" ]] && continue

      if [[ "$key" == GATE_* ]]; then
        [[ "$v" == "approved" ]] && continue
        done_all=0
        local dec; gate_wait "$t" "$key"; dec=$GATE_DECISION
        if [[ "$dec" == rejected ]]; then
          case "$key" in
            GATE_PLAN)  set_st "$t" --replan ;;
            GATE_CAUSE) set_st "$t" GATE_CAUSE pending DIAGNOSE pending HYPOSKEPTIC pending PROOF pending ;;
            *)          # откат по МАРШРУТУ ПРОФИЛЯ, а не по фиксированному списку:
                        # у другого проекта после сборки свои этапы (регресс, скриншоты),
                        # и захардкоженный сброс оставлял бы их пройденными
                        local _r=0 _k
                        for _k in "${STAGES[@]}"; do
                          [[ "$_k" == BUILD ]] && _r=1
                          (( _r )) && set_st "$t" "$_k" pending
                        done
                        (( _r )) || set_st "$t" --reject-accept ;;
          esac
          flog "$t" "$key отклонён — откат"
        fi
        break
      fi

      done_all=0
      if run_stage "$t" "$key"; then continue; else
        local rc=$?
        # rc=2 — run_stage уже исчерпал безопасные попытки или получил ошибку,
        # которую запрещено переносить на другой ИИ, и поставил STALLED_HUMAN.
        # Продолжение внешнего while запускало новый пакет попыток: REVIEW #7379
        # так накопил 113 сбоев вместо одного явного стопа.
        (( rc == 2 )) && return 2
        if (( rc == 1 )); then
          # failed: считаем возвраты, чтобы не крутить агента бесконечно
          local rt; rt=$(get "$t" "${key}_RETRIES"); rt=${rt:-0}; rt=$((rt+1))
          set_st "$t" "${key}_RETRIES" "$rt"
          if (( rt > 2 )); then
            flog "$t" "$key: 2 возврата не помогли — СТОП, нужен человек"
            set_st "$t" STALLED_HUMAN 1
            return 1
          fi
          # куда откатывать: диагностические этапы — к началу диагностики, прочие — в сборку
          case "$key" in
            REPRO|INSTRUMENT|DIAGNOSE|HYPOSKEPTIC|PROOF)
              flog "$t" "возврат к диагностике из-за $key (попытка $rt)"
              set_st "$t" "$key" pending DIAGNOSE pending HYPOSKEPTIC pending PROOF pending ;;
            *)
              flog "$t" "возврат в Build из-за $key (попытка $rt)"
              # Сбрасываем ВЕСЬ хвост от Build, а не только сам Build: иначе ворота,
              # уже вставшие в «жду человека» на прошлом проходе, остаются в этом
              # состоянии — и на схеме одновременно горят активный этап и приёмка.
              # Защита «один running» такое не ловит: waiting — это не running.
              local _tail=() _hit=0 _st
              for _st in "${STAGES[@]}"; do
                [[ "$_st" == "BUILD" ]] && _hit=1
                [[ $_hit == 1 ]] && _tail+=("$_st" pending)
              done
              set_st "$t" "$key" pending "${_tail[@]}" ;;
          esac
        fi
        break
      fi
    done
    # Эскалация маршрута (trivial → feature): перечитать этапы и начать заново
    local now_route; now_route=$(get "$t" ROUTE)
    if [[ -n "$now_route" && "$now_route" != "$route" ]]; then
      if ! declare -p "PROFILE_ROUTE_STAGES_${now_route}" >/dev/null 2>&1; then
        flog "$t" "этап попросил маршрут '$now_route', которого нет — веду как feature"
        now_route=feature; set_st "$t" ROUTE feature
      fi
      flog "$t" "маршрут эскалирован: $route → $now_route"
      route="$now_route"
      local -n STAGES="PROFILE_ROUTE_STAGES_${route}"
      continue
    fi
    (( done_all == 1 )) && break
  done

  flog "$t" "все этапы маршрута пройдены"

  # Прогон завершён — убираем карточку с дашборда (реестр уезжает в архив, телеметрия
  # и отчёт остаются). Включается профилем: у проектов с задачами карточка может жить
  # дольше (демо, ретро), а у прогонов по промпту показывать нечего.
  if [[ "${PROFILE_ARCHIVE_ON_FINISH:-0}" == 1 ]]; then
    mkdir -p "$STATE_DIR/archive"
    mv -f "$STATE_DIR/t${t}.pipeline" "$STATE_DIR/archive/t${t}.pipeline" 2>/dev/null \
      && flog "$t" "прогон завершён — карточка убрана с дашборда (реестр в архиве)"
  fi
}
