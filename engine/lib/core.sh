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
# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/workspace-guard.sh"
CONTROL_DIR=$(factory_control_root) || {
  echo "Некорректный FACTORY_CONTROL_ROOT: control metadata не должна пересекаться с STATE_DIR" >&2
  return 78 2>/dev/null || exit 78
}
mkdir -p "$CONTROL_DIR"
[[ ! -L "$CONTROL_DIR" && "$(realpath -e -- "$CONTROL_DIR" 2>/dev/null)" == "$CONTROL_DIR" ]] || {
  echo "Небезопасный FACTORY_CONTROL_ROOT: symlink запрещён" >&2
  return 78 2>/dev/null || exit 78
}
chmod 700 "$CONTROL_DIR" 2>/dev/null || true

# --- вторичный реестр статусов: host/control projection ---
_pf() { echo "$STATE_DIR/t${1}.pipeline"; }
set_st() {
  local t=$1; shift
  if [[ "${1:-}" == --init ]]; then
    shift
    [[ "${1:-}" == --stages ]] || return 78
    shift
    local stages=${1:-}; shift
    pipeline_store_route_init "$t" "$stages" "$@"
    return
  fi
  run_state_control_update "$t" "$@"
}
get() { grep "^$2=" "$(_pf "$1")" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
set_stage_terminal() {
  local t=$1 stage=$2 result=$3; shift 3
  run_state_control_update "$t" "$stage" "$result" "$@"
}
# Пишем ТОЛЬКО в файл: stdout демона и так перенаправлен в этот же журнал (bin/factory),
# поэтому tee давал каждую строку дважды и журнал читался как «всё случилось два раза».
flog() { echo "$(date '+%F %T') [t${1}] ${*:2}" >>"$LOGDIR/t${1}.stages.log"; }

# --- доверенные standalone-настройки агента ---
# Route runner отключает user/project/local sources, поэтому этот engine-owned файл
# содержит весь session policy.
#
# ВРЕМЕННО СНЯТО: обязательная native OS sandbox граница (`"sandbox":{"enabled":true,
# "failIfUnavailable":true,"allowUnsandboxedCommands":false,…}`). На Linux эта песочница —
# bwrap, то есть user namespace: в нём отображены только uid/gid 1000, а дополнительные
# группы теряются. Значит `/var/run/docker.sock` (root:docker 0660) виден агенту как
# nobody:nogroup и недоступен, а сеть уходит в свой namespace, где localhost-порт стенда
# просто «в соединении отказано». Рантайм-этапы ходят в стенд ровно этими двумя каналами
# (docker exec + API), поэтому t7802 упал на REPRO: агент видел код, но не мог снять ни
# одного рантайм-сигнала. `allowUnsandboxedCommands:false` закрывал и escape-hatch, так что
# обойти было нечем. Вернуть границу можно только вместе с каналом до стенда: сокет-прокси
# от своего uid (per-path allowUnixSockets на Linux не работает — только allowAllUnixSockets)
# либо песочница по классу узла. Подробности — ../docs/engine/ENGINE.md.
# Мало дать доступ к каталогам: статус этапа выставляется КОМАНДОЙ, а bash-команды одобряются
# отдельно от правок файлов. Без этого агент доходит до последнего шага и просит разрешение —
# в неинтерактивном режиме это значит «этап не завершён» и повтор с нуля.
# Профиль может добавить свои команды через массив PROFILE_AGENT_ALLOW (например прогон тестов).
_agent_settings() {
  local stage=${1:-} task=${2:-} settings_key
  [[ -z "$stage" || "$stage" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]] || return 78
  [[ -z "$task" || "$task" =~ ^[1-9][0-9]{0,18}$ ]] || return 78
  settings_key=${stage:-any}
  [[ -z "$task" ]] || settings_key="t${task}-${settings_key}"
  local f="$CONTROL_DIR/agent-settings-${settings_key}.json" rules extra="" tmp tool_control
  if declare -p PROFILE_AGENT_ALLOW >/dev/null 2>&1; then
    local r
    for r in "${PROFILE_AGENT_ALLOW[@]}"; do extra+=",\"$r\""; done
  fi
  # Чувствительные команды профиль выдаёт по роли узла. Глобальный массив
  # остаётся для безопасных общих инструментов и обратной совместимости профилей.
  if [[ -n "$stage" ]] && declare -F profile_stage_agent_allow >/dev/null; then
    local stage_extra r
    stage_extra=$(profile_stage_agent_allow "$stage") || return
    while IFS= read -r r || [[ -n "$r" ]]; do
      [[ -n "$r" ]] || continue
      [[ "$r" != *'"'* && "$r" != *$'\t'* && "$r" != *$'\r'* ]] || return 78
      extra+=",\"$r\""
    done <<<"$stage_extra"
  fi
  # Базовый набор: без него этап не может ни осмотреться, ни записать свой отчёт. В одном
  # прогоне накопились сотни отказов Bash/Write, включая запись t<TASK>.recon.md
  # в каталог самой фабрики. Отказ в неинтерактивном режиме не виден: агент молча перебирает
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
  # Браузер — по явному разрешению узла маршрута (`policy.browser`), а не по
  # факту наличия MCP-сервера у CLI. Иначе разведка может менять данные живого
  # приложения песочницы, хотя этап должен только читать код.
  if [[ "${FACTORY_ROUTE_BROWSER_POLICY:-}" == forbid ]]; then
    deny+=',"mcp__playwright","mcp__playwright__*"'
  fi

  # ГЛАВНЫЙ рубеж для проверочных этапов: запрет ПИСАТЬ в каталоги проекта вообще.
  # Списка команд мало — он ловит «eslint --fix», но не «eslint . --fix» и не правку файла
  # редактором напрямую. Линт дважды (21.07 и 22.07) переформатировал 278-280 чужих файлов
  # в ветке задачи, хотя запрет в промпте стоял: просьба не работает, работает отсутствие прав.
  # Политикой файловой системы владеет закреплённый route bundle.
  if [[ -n "$stage" && "${FACTORY_ROUTE_FILESYSTEM_POLICY:-}" == state-only ]]; then
    local d
    for d in ${PROFILE_AGENT_DIRS:-}; do
      deny+=",\"Edit(${d}/**)\",\"Write(${d}/**)\",\"NotebookEdit(${d}/**)\""
    done
    # ЗАПРЕТА Edit/Write МАЛО: базовый allow выше открывает bash, а через bash файл
    # правится в обход прав на редактирование. LINT может переписать комментарий через
    # `sed -i`, затем унести файл задачи в `git stash`, раскидать файл по контейнерам
    # через `docker cp` и перемонтировать основной стенд.
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
    # Обёртки, запускающие ЛЮБУЮ команду под своим именем. Правило сверяет ПРЕФИКС, поэтому
    # `timeout 60 sed -i …` не совпадает ни с одним запретом выше и проходит целиком. Хуже:
    # в личных настройках человека `Bash(timeout:*)` стоит в allow — то есть весь список
    # запретов обходится одним словом, и обходится молча. Запрещаем сами обёртки: этапу,
    # который только читает, они не нужны ни одной.
    deny+=',"Bash(timeout:*)","Bash(env:*)","Bash(xargs:*)","Bash(nohup:*)","Bash(setsid:*)"'
    deny+=',"Bash(stdbuf:*)","Bash(nice:*)","Bash(sudo:*)","Bash(sh -c:*)","Bash(bash -c:*)"'
    # Скрипты-обёртки package.json: что внутри — знает только сам package.json.
    # `npm run lint` фронта может оказаться объявлен как `eslint . --fix`, и автофикс перепишет
    # 276 чужих файлов, хотя флага --fix в команде агента не было и запрет на него стоял
    # и в промпте, и в deny. Проверочный этап зовёт линтер НАПРЯМУЮ (npx eslint --no-fix,
    # pint --test) — тогда команда видна целиком и правилами выражается. Прочие npm-скрипты
    # (сборка, e2e) не трогаем: режем только класс lint/format/fix.
    deny+=',"Bash(npm run lint)","Bash(npm run lint:*)","Bash(npm run format:*)","Bash(npm run fix:*)"'
    deny+=',"Bash(yarn lint:*)","Bash(pnpm lint:*)","Bash(npm exec eslint:*)"'
  fi

  # Permission syntax uses // for an absolute filesystem path. Deny both the
  # directory entry and every descendant: Read/Edit/Write/NotebookEdit are not
  # governed by Bash sandboxing and therefore need their own tool-level wall.
  # Пока sandbox снят (см. шапку функции), это единственная стена вокруг control root:
  # bash-командой каталог по-прежнему достижим, как было до ужесточения.
  [[ "$CONTROL_DIR" =~ ^/[A-Za-z0-9._/@%+=,:~-]+$ ]] || return 78
  tool_control="//${CONTROL_DIR#/}"
  deny+=",\"Read(${tool_control})\",\"Read(${tool_control}/**)\""
  deny+=",\"Edit(${tool_control})\",\"Edit(${tool_control}/**)\""
  deny+=",\"Write(${tool_control})\",\"Write(${tool_control}/**)\""
  deny+=",\"NotebookEdit(${tool_control})\",\"NotebookEdit(${tool_control}/**)\""

  tmp=$(mktemp "$CONTROL_DIR/.agent-settings.XXXXXX") || return 1
  printf '{"permissions":{"allow":[%s],"deny":[%s]}}' \
    "$rules" "$deny" >"$tmp" || {
      rm -f -- "$tmp"
      return 1
    }
  chmod 400 -- "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  mv -f -- "$tmp" "$f" || {
    rm -f -- "$tmp"
    return 1
  }
  echo "$f"
}

# --- лимит времени этапа ---
# Источник правды — КЛАСС узла из бандла маршрута (policy.timeoutClass), а не имя этапа:
# время диктует РОЛЬ узла (планирование, сборка, браузерная приёмка), и одна и та же схема
# должна вести себя одинаково у всех проектов. Дефолты ниже покрывают классы канонических
# маршрутов и намеренно повторяют прежние project-specific тайминги:
# смена источника правды не должна менять поведение работающих конвейеров.
_stage_timeout_class_default() {
  case "$1" in
    planning|standard|review|delivery|check) echo 1800 ;;
    test|build)                              echo 3600 ;;
    diagnostic|browser)                      echo 5400 ;;
    *)                                       echo ''   ;;
  esac
}

# $1=TASK $2=этап; echo секунды. Порядок: класс узла → хук профиля по классу → NODE_TIMEOUT.
_stage_timeout() {
  local t=${1:-} stage=${2:-} cls="${FACTORY_ROUTE_TIMEOUT_CLASS:-}" tmo="$NODE_TIMEOUT" v=""
  if [[ -n "$cls" ]]; then
    v=$(_stage_timeout_class_default "$cls")
    if [[ "$v" =~ ^[0-9]+$ ]]; then
      tmo="$v"
    else
      # Бандл объявил класс, которого движок не знает: молча взять дефолт — значит
      # дать узлу чужой лимит и потерять его работу по таймауту. Пишем в журнал.
      [[ -n "$t" ]] && flog "$t" "ЛИМИТ: неизвестный timeoutClass=$cls, беру $tmo с"
    fi
    # Проект вправе переопределить класс: у одного тесты идут пять минут, у другого час.
    if declare -F profile_timeout_class >/dev/null; then
      v=$(profile_timeout_class "$cls" 2>/dev/null)
      [[ "$v" =~ ^[0-9]+$ ]] && tmo="$v"
    fi
  fi
  printf '%s' "$tmo"
}

# --- черновик хода этапа ---
# Единственный терминальный канал — stage-result, и он срабатывает В КОНЦЕ. Между началом
# этапа и этим вызовом у движка нет ничего: убитый по таймауту агент уносит с собой всё, что
# успел понять. stage-progress сюда не годится — он маршрутный (ROUTE/SIZE/PLANS) и валидирует
# фиксированный список ключей, произвольную запись не принимает и принимать не должен.
# Поэтому черновик — обычный файл в STATE_DIR: агент уже имеет туда запись (см. _agent_settings),
# файл переживает и таймаут, и SIGKILL, и его же читает следующий заход.
# Имя детерминированное — по задаче и этапу: следующий заход должен НАЙТИ файл, не зная run_id.
_stage_checkpoint_path() {
  local t=$1 stage=${2:-any} lc
  lc=$(printf '%s' "${stage,,}" | tr -c 'a-z0-9_' '_')
  printf '%s/t%s.%s.checkpoint.md' "$STATE_DIR" "$t" "$lc"
}

# Черновик снимается, когда узел ЗАКРЫТ терминально (см. route-runtime): иначе повторный
# заход на тот же узел через полгода получит чужие заметки и примет их за свои.
_stage_checkpoint_clear() {
  local f; f=$(_stage_checkpoint_path "$1" "${2:-}")
  [[ -f "$f" && ! -L "$f" ]] && rm -f -- "$f"
  return 0
}

# --- регламент времени в промпт ---
# Лимит знал только движок, агент работал вслепую и планировал проверки без оглядки на
# срок. Из-за этого он может уйти в необязательную регрессию, не успеть отчитаться и
# потерять вместе с этапом готовый код. Отдельного канала до агента нет, промпт
# нигде не хешируется, поэтому регламент приписывается служебным блоком в конец.
# Мягкий срок — 4/5 лимита: остаток нужен на саму фиксацию результата, она не мгновенная.
_stage_time_budget_block() {
  local tmo=$1 soft=$(( $1 * 4 / 5 )) ckpt=${2:-}
  cat <<EOF
---

## Регламент времени этапа (от движка, не от автора промпта)

Жёсткий предел — **$(( tmo / 60 )) мин** с начала этапа. По его истечении процесс
обрывается без предупреждения.

Всё, что не зафиксировано через \`stage-result\`, пропадает целиком: движок считает
такой этап невыполненным и запускает его заново с нуля, ничего не переиспользуя.
Правки в рабочем дереве при этом остаются, но следующий заход о них не знает.

Планируй так, чтобы результат был зафиксирован к **$(( soft / 60 )) мин**. Если к
этому сроку главное сделано, а проверки нет — фиксируй сделанное и опиши остаток
в отчёте. Не начинай длинную проверку, которая заведомо не уложится в остаток.

ЧЕРНОВИК ХОДА — \`${ckpt}\`. Дописывай туда строку каждый раз, когда закончил
осмысленный кусок: что сделано, где лежит, что проверено и что осталось. Это дёшево
(одна строка) и это единственное, что переживёт обрыв: файл достанется следующему
заходу дословно. Черновик ничего не завершает — этап закрывает только \`stage-result\`.
EOF
}

# --- черновик предыдущего захода в промпт ---
# Файл достаётся заходу целиком, но с хвоста и с потолком: журнал на мегабайт вытеснит
# из окна само задание этапа, а ценен в нём именно конец — то, на чём заход оборвался.
_stage_checkpoint_block() {
  local f=$1 body
  body=$(tail -c 6000 -- "$f" 2>/dev/null) || return 0
  [[ -n "$body" ]] || return 0
  cat <<EOF
---

## Черновик незакрытого захода этого этапа

Этап уже начинали, и он оборвался, не зафиксировав результат. Вот что успел записать
предыдущий заход (файл \`$f\`, последние строки):

\`\`\`
$body
\`\`\`

Это заметки, а не доказательство: сначала проверь, что описанное действительно на месте
(\`git status\`, \`git diff\`, файлы отчётов), и только потом продолжай с этого места.
Расхождение черновика с рабочим деревом — само по себе находка, назови её в отчёте.
EOF
}

# --- контекст повтора в промпт ---
# Ретрай начинается с чистого листа: движок помнит, что заход не первый, а агент — нет.
# Без контекста повторный BUILD переделывает уже написанный код. Следы предыдущего захода
# никуда не делись — заставляем сначала посмотреть.
_stage_retry_block() {
  local n=$1 reason=$2 what
  case "$reason" in
    no-result) what='оборвался, не зафиксировав результат (таймаут или падение процесса)' ;;
    failed)    what='закончился отказом по существу задачи' ;;
    *)         what='не довёл этап до конца' ;;
  esac
  cat <<EOF
---

## Это повтор этапа (заход $n)

Предыдущий заход $what. Движок считает этап невыполненным, но следы работы остались:
правки в рабочем дереве, черновики, записи в артефактах.

Начни с осмотра сделанного — \`git status\` и \`git diff\` в рабочем дереве, отчёты
предыдущих узлов. Доделай недостающее и проверь целостность, а не переписывай заново:
переделка с нуля стоит столько же, сколько первый заход, и так же рискует не уложиться.
EOF
}

# --- указание человека при возврате курсора в промпт ---
# Свободный текст от человека доезжал до агента только через решения ВОРОТ. У обычного
# узла канала не было: кнопка «перейти сюда» писала причину в журнал попытки и на этом
# всё — агент входил с тем же заданием и повторял ту же ошибку. Разбор приходилось
# протаскивать через черновик хода, то есть мимо журнала, а журнал — главный инвариант.
# Блок идёт ПОСЛЕДНИМ и прямо объявляет приоритет: черновик выше по промпту зовёт
# «продолжай с этого места», а человек мог вернуть узел именно чтобы свернуть с него.
_stage_human_note_block() {
  local note=$1
  cat <<EOF
---

## Указание человека при возврате на этот узел

Узел не пришёл сюда сам: человек вернул на него курсор и оставил указание.

> $note

Это главное в задании. Если оно расходится с черновиком предыдущего захода или с
отчётами прошлых узлов — прав человек, а расхождение назови в отчёте. Если указание
невыполнимо или неверно по фактам, не выполняй его молча и не выдумывай обход:
зафиксируй результат с объяснением, что именно не сходится.
EOF
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
  # минут, не может выставить статус этапа — движок считает этап незавершённым и гоняет его заново.
  # FACTORY_HOME нужен для run-scoped stage-result/stage-progress и служебных команд движка.
  # Лимит времени этапа: браузерные замеры и прогон сценариев идут дольше правки кода.
  # Убитый по таймауту агент теряет ВСЮ работу этапа, поэтому лимит должен быть осознанным.
  local tmo; tmo=$(_stage_timeout "$t" "$stage")
  local ckpt; ckpt=$(_stage_checkpoint_path "$t" "$stage")
  export FACTORY_STAGE_CHECKPOINT="$ckpt"
  prompt+=$'\n\n'"$(_stage_time_budget_block "$tmo" "$ckpt")"
  local retry_no="${FACTORY_STAGE_RETRY:-}"
  if [[ "$retry_no" =~ ^[2-9]|^[0-9]{2,}$ ]]; then
    prompt+=$'\n\n'"$(_stage_retry_block "$retry_no" "${FACTORY_STAGE_RETRY_REASON:-}")"
  fi
  # Черновик отдаём по НАЛИЧИЮ файла, а не по счётчику захода: после убитого оркестратора
  # resume входит в узел заново с номером 1.
  if [[ -s "$ckpt" && ! -L "$ckpt" ]]; then
    prompt+=$'\n\n'"$(_stage_checkpoint_block "$ckpt")"
  fi
  # Последним — чтобы не потеряться за черновиком и регламентом: это единственный блок,
  # который написал человек, а не движок.
  if [[ -n "${FACTORY_STAGE_HUMAN_NOTE:-}" ]]; then
    prompt+=$'\n\n'"$(_stage_human_note_block "${FACTORY_STAGE_HUMAN_NOTE}")"
  fi
  export RUNNER_CLAUDE_SETTINGS RUNNER_CLAUDE_CONTROL_DIR
  RUNNER_CLAUDE_SETTINGS=$(_agent_settings "$stage" "$t") || return
  RUNNER_CLAUDE_CONTROL_DIR=$CONTROL_DIR
  export RUNNER_CLAUDE_ADD_DIRS="$STATE_DIR ${PROFILE_AGENT_DIRS:-}"
  export RUNNER_CODEX_ADD_DIRS="$STATE_DIR ${PROFILE_AGENT_DIRS:-}"
  export RUNNER_KIMI_ADD_DIRS="$STATE_DIR ${PROFILE_AGENT_DIRS:-}"

  # Shared-профиль может дать агенту узкий engine-owned control channel. Hook
  # стартует до provider CLI, stop выполняется при любом результате runner-а.
  # Это не lifecycle стенда: broker только исполняет заранее разрешённые команды
  # существующего ресурса. Codex сам монтирует control dir read-only — добавлять
  # его в общий writable --add-dir нельзя.
  local agent_control_started=0 runner_rc stop_rc=0
  local has_agent_control_start=0 has_agent_control_stop=0
  declare -F profile_agent_control_start >/dev/null && has_agent_control_start=1
  declare -F profile_agent_control_stop >/dev/null && has_agent_control_stop=1
  (( has_agent_control_start == has_agent_control_stop )) || return 78
  if (( has_agent_control_start )); then
    profile_agent_control_start "$t" "$stage" || return
    agent_control_started=1
    if [[ -n "${PROFILE_AGENT_CONTROL_DIR:-}" ]]; then
      RUNNER_CLAUDE_ADD_DIRS+=" $PROFILE_AGENT_CONTROL_DIR"
    fi
    export RUNNER_CODEX_ADD_DIRS RUNNER_CLAUDE_ADD_DIRS
  fi
  multi_runner_run "$t" "$prompt" "$stage" "$tmo"
  runner_rc=$?
  if (( agent_control_started )); then
    profile_agent_control_stop "$t" "$stage" "$runner_rc" || stop_rc=$?
  fi
  (( stop_rc == 0 )) || return 75
  return "$runner_rc"
}
