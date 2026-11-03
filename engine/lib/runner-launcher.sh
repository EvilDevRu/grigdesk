#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"
source "$FACTORY_HOME/lib/debug-log.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/status-request.sh"
source "$FACTORY_HOME/lib/runtime-analytics.sh"
source "$FACTORY_HOME/lib/provider-lineage-state.sh"
source "$FACTORY_HOME/lib/browser-transport.sh"

_runner_process_full_identity() {
  local pid=${1:?pid} stat tail
  local -a fields=()
  # Читаем редиректом, а не `cat`: identity опрашивается в циклах ожидания
  # тишины, и форк на каждый процесс обходился дороже самой остановки.
  # Порядок редиректов важен: stderr гасим ДО открытия файла, иначе процесс,
  # умерший между глобом и чтением, печатает ошибку в лог этапа.
  read -r stat 2>/dev/null <"/proc/$pid/stat" || return 1
  [[ -n "$stat" ]] || return 1
  # Поле comm заключено в скобки и само может содержать пробелы или `)`.
  # После последнего `) ` идут поля proc(5) со стабильными позициями:
  # состояние, PID родителя, PGID, сессия, ... время запуска.
  tail=${stat##*) }
  read -r -a fields <<<"$tail"
  (( ${#fields[@]} >= 20 )) || return 1
  [[ "${fields[0]}" =~ ^[A-Z]$ &&
     "${fields[1]}" =~ ^[0-9]+$ &&
     "${fields[2]}" =~ ^[0-9]+$ &&
     "${fields[3]}" =~ ^[0-9]+$ &&
     "${fields[19]}" =~ ^[0-9]+$ ]] || return 1
  printf '%s %s %s %s %s\n' \
    "${fields[2]}" "${fields[3]}" "${fields[19]}" "${fields[0]}" "${fields[1]}"
}

_runner_process_identity() {
  local pid=${1:?pid} identity pgid session starttime state ppid
  identity=$(_runner_process_full_identity "$pid") || return 1
  read -r pgid session starttime state ppid <<<"$identity"
  printf '%s %s\n' "$pgid" "$starttime"
}

runner_process_matches() {
  local pid=${1:?pid} expected_pgid=${2:?pgid} expected_starttime=${3:?starttime}
  local identity pgid session starttime state ppid
  identity=$(_runner_process_full_identity "$pid") || return 1
  read -r pgid session starttime state ppid <<<"$identity"
  [[ "$pgid" == "$expected_pgid" && "$starttime" == "$expected_starttime" ]]
}

runner_process_full_matches() {
  local pid=${1:?pid} expected_pgid=${2:?pgid}
  local expected_session=${3:?session} expected_starttime=${4:?starttime}
  local identity pgid session starttime state ppid
  identity=$(_runner_process_full_identity "$pid") || return 1
  read -r pgid session starttime state ppid <<<"$identity"
  [[ "$pgid" == "$expected_pgid" &&
     "$session" == "$expected_session" &&
     "$starttime" == "$expected_starttime" ]]
}

# Границей раннера служит СЕССИЯ, которую runner_launch создаёт через setsid
# ровно под один запуск, а не группа процессов её лидера: GNU timeout ставит
# провайдеру собственную группу (setpgid), поэтому дерево агента живёт в другой
# группе той же сессии. Пока проверка смотрела только на группу лидера, пустая
# группа ложно доказывала тишину: claude, MCP и docker могли пережить TERM,
# когда launcher уже снял trusted identity.
# Печатает уникальные PGID живых процессов сессии; 1 — в сессии никого нет.
# Обход отдан awk одним форком: при большом числе процессов чтение /proc средствами
# bash создавало отдельный временный файл на каждый процесс, и цикл ожидания тишины
# обходился дороже самой остановки. Данные те же самые —
# awk читает те же /proc/<pid>/stat.
# Файлы открываются ЧЕРЕЗ getline, а не передачей в поток ввода: процесс,
# исчезнувший между globом и открытием, для awk (и gawk, и mawk) — «критическая
# ошибка», после которой он обрывает обработку целиком и не печатает ничего.
# Одного такого процесса на машине хватало, чтобы скан объявил живую сессию
# пустой, а это ложное доказательство тишины: launcher снимал trusted identity
# при живом дереве агента. Ради этого скан и написан.
# getline на исчезнувшем файле — просто «не прочиталось», такой pid пропускаем.
_runner_session_pgids() {
  local expected_session=${1:?session} pgids
  [[ "$expected_session" =~ ^[0-9]+$ ]] || return 2
  # comm в скобках и может содержать пробелы и ')'. После последней ') '
  # позиции полей proc(5) стабильны: state, ppid, pgrp, session, ...
  pgids=$(awk -v sess="$expected_session" '
    BEGIN {
      for (i = 1; i < ARGC; i++) {
        file = ARGV[i]
        if ((getline line < file) <= 0) { close(file); continue }
        close(file)
        if (!sub(/.*\) /, "", line)) continue
        if (split(line, f, " ") < 4) continue
        if (f[4] != sess || f[3] !~ /^[0-9]+$/) continue
        if (f[3] in seen) continue
        seen[f[3]] = 1
        out = (out == "" ? f[3] : out " " f[3])
      }
      if (out != "") print out
      exit 0
    }
  ' /proc/[0-9]*/stat 2>/dev/null)
  [[ -n "$pgids" ]] || return 1
  printf '%s\n' "$pgids"
}

_runner_own_session() {
  local self=$BASHPID identity pgid session starttime state ppid
  identity=$(_runner_process_full_identity "$self") || return 1
  read -r pgid session starttime state ppid <<<"$identity"
  [[ "$session" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$session"
}

# 0 — PGID точно переиспользован ядром под чужой процесс: лидер читается, но у
# него другой starttime. Нечитаемый лидер приговором не считается.
_runner_pgid_recycled() {
  local pgid=$1 expected_starttime=${2:-} identity
  local leader_pgid leader_session leader_starttime leader_state leader_ppid
  [[ -n "$expected_starttime" ]] || return 1
  identity=$(_runner_process_full_identity "$pgid" 2>/dev/null || true)
  [[ -n "$identity" ]] || return 1
  read -r leader_pgid leader_session leader_starttime leader_state leader_ppid \
    <<<"$identity"
  [[ "$leader_starttime" != "$expected_starttime" ]]
}

_runner_runtime_present() {
  local expected_pgid=${1:?pgid} expected_session=${2:?session}
  local expected_starttime=${3:-} attempt
  [[ "$expected_pgid" =~ ^[0-9]+$ && "$expected_session" =~ ^[0-9]+$ &&
     ( -z "$expected_starttime" || "$expected_starttime" =~ ^[0-9]+$ ) ]] ||
    return 2
  # Дешёвый вопрос ядру про исходную группу идёт первым, и пока раннер жив,
  # им всё и заканчивается: скан сессии даже одним форком стоит десятки
  # миллисекунд, а этим путём идут циклы ожидания и хвост каждого этапа.
  if kill -0 -- "-$expected_pgid" 2>/dev/null &&
     ! _runner_pgid_recycled "$expected_pgid" "$expected_starttime"; then
    # Группа цела и не переиспользована. Нечитаемый или гоночный вид /proc
    # трактуем как «жив», но никогда как тишину.
    return 0
  fi
  # Пустая группа лидера — ещё не тишина: под GNU timeout провайдер живёт в
  # своей группе той же сессии. Два прохода закрывают дыру «процесс форкнулся
  # ровно во время обхода /proc».
  for attempt in 1 2; do
    _runner_session_pgids "$expected_session" >/dev/null && return 0
    (( attempt == 2 )) || sleep 0.01
  done
  return 1
}

runner_runtime_absent() {
  ! _runner_runtime_present "$1" "$2" "${3:-}"
}

# Цели сигнала: исходная группа раннера плюс каждая группа, которую его потомки
# завели внутри той же сессии. Чужая группа под сигнал не попадёт, пока в ней
# жив хоть один процесс нашей сессии: её создал наш же setsid, и чтобы
# промахнуться, ядро должно переиспользовать PGID между сканом и kill — окно в
# микросекунды, которое видит следующий скан цикла ожидания.
_runner_runtime_groups() {
  local pgid=${1:?pgid} session=${2:?session} group pgids groups=$pgid
  pgids=$(_runner_session_pgids "$session") || {
    printf '%s\n' "$groups"
    return 0
  }
  for group in $pgids; do
    [[ "$group" != "$pgid" ]] || continue
    groups+=" $group"
  done
  printf '%s\n' "$groups"
}

_runner_signal_groups() {
  local sig=${1:?sig} groups=${2:-} group
  for group in $groups; do
    kill -"$sig" -- "-$group" 2>/dev/null || true
  done
}

# 0 — жива хоть одна из уже известных групп. Дешёвая половина цикла ожидания:
# пока сигнал ещё разбирают, полного скана сессии не нужно.
_runner_groups_present() {
  local groups=${1:-} group
  for group in $groups; do
    kill -0 -- "-$group" 2>/dev/null && return 0
  done
  return 1
}

_runner_signal_runtime() {
  local sig=${1:?sig} pgid=${2:?pgid} session=${3:?session} groups
  groups=$(_runner_runtime_groups "$pgid" "$session")
  _runner_signal_groups "$sig" "$groups"
}

_runner_reap_if_zombie() {
  local pid=$1 expected_pgid=$2 expected_starttime=$3 identity
  local pgid session starttime state ppid
  identity=$(_runner_process_full_identity "$pid") || return 0
  read -r pgid session starttime state ppid <<<"$identity"
  [[ "$pgid" == "$expected_pgid" && "$starttime" == "$expected_starttime" ]] ||
    return 0
  [[ "$state" == Z ]] || return 0
  wait "$pid" 2>/dev/null || true
}

_runner_quiesce_owned_runtime() {
  local pid=$1 pgid=$2 session=$3 starttime=$4 grace_s=${5:-5}
  local polls poll own_session groups
  [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ &&
     "$session" =~ ^[0-9]+$ && "$starttime" =~ ^[0-9]+$ &&
     "$grace_s" =~ ^[0-9]+$ ]] || return 2
  # Собственную сессию не сигналим никогда: раз граница остановки — сессия,
  # ошибка в идентити не имеет права снести оркестратор, который её запросил.
  own_session=$(_runner_own_session) || return 2
  [[ "$session" != "$own_session" ]] || return 2

  runner_runtime_absent "$pgid" "$session" "$starttime" && {
    _runner_reap_if_zombie "$pid" "$pgid" "$starttime"
    return 0
  }
  # Цели считаем ОДИН раз, и порядок TERM → CONT намеренный: раннеру,
  # остановленному на барьере, TERM ставится в очередь и доставляется ровно в
  # момент разморозки. Обратный порядок оставлял окно между CONT и TERM, в
  # которое размороженный мост успевал вызвать provider CLI мимо барьера, —
  # это и ловил мигающий ассерт runner-contract «отложенный сигнал останавливает
  # раннер до того, как код провайдера пересечёт барьер».
  groups=$(_runner_runtime_groups "$pgid" "$session")
  _runner_signal_groups TERM "$groups"
  _runner_signal_groups CONT "$groups"
  polls=$((grace_s * 20))
  for (( poll=0; poll<=polls; poll++ )); do
    _runner_reap_if_zombie "$pid" "$pgid" "$starttime"
    if ! _runner_groups_present "$groups"; then
      runner_runtime_absent "$pgid" "$session" "$starttime" && return 0
      # Известные группы опустели, а сессия — нет: потомок успел завести ещё
      # одну группу уже после первого скана. Добираем цели и даём и ей уйти
      # по-хорошему, иначе она молча досидела бы до KILL.
      groups=$(_runner_runtime_groups "$pgid" "$session")
      _runner_signal_groups TERM "$groups"
      _runner_signal_groups CONT "$groups"
    fi
    (( poll == polls )) || sleep 0.05
  done

  # Исходной точной группе отправили сигнал, пока идентичность её лидера ещё принадлежала
  # этому запускателю. Выживший процесс сохраняет PGID/session, поэтому KILL не может
  # попасть в новую постороннюю группу, повторно получившую тот же идентификатор.
  groups=$(_runner_runtime_groups "$pgid" "$session")
  _runner_signal_groups KILL "$groups"
  for poll in {1..100}; do
    _runner_reap_if_zombie "$pid" "$pgid" "$starttime"
    if ! _runner_groups_present "$groups"; then
      runner_runtime_absent "$pgid" "$session" "$starttime" && return 0
      groups=$(_runner_runtime_groups "$pgid" "$session")
      _runner_signal_groups KILL "$groups"
    fi
    sleep 0.05
  done
  return 1
}

runner_trusted_identity_file() {
  local task=${1#[tT]} root
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ ]] || return 2
  root=$(factory_control_root) || return
  printf '%s/runner-processes/t%s.active\n' "$root" "$task"
}

_runner_trusted_identity_prepare() {
  local root dir uid
  root=$(factory_control_root) || return
  [[ -d "$root" && ! -L "$root" &&
     "$(realpath -e -- "$root" 2>/dev/null)" == "$root" ]] || return 78
  dir="$root/runner-processes"
  mkdir -p -- "$dir" || return 1
  chmod 700 "$dir" 2>/dev/null || return 1
  uid=$(id -u)
  [[ -d "$dir" && ! -L "$dir" &&
     "$(realpath -e -- "$dir" 2>/dev/null)" == "$dir" &&
     "$(stat -c '%u:%a:%h' "$dir" 2>/dev/null)" == "$uid:700:2" ]] ||
    return 78
}

runner_trusted_identity_read() {
  local task=${1#[tT]} expected_stage=${2:-} expected_run=${3:-} expected_epoch=${4:-}
  local file uid meta="" fd="" attempt
  local -a lines=()
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ ]] || return 2
  file=$(runner_trusted_identity_file "$task") || return
  [[ -L "$file" ]] && return 78
  # Дальше и проверка доверия, и чтение идут по ОДНОМУ дескриптору. Через путь
  # получалось так: stat смотрел один inode, а mapfile читал другой, который
  # конкурентный publish успел подменить, — доверие подтверждалось не тем
  # файлом, чьи данные уезжали вызывающему.
  # Снятие записи — штатная часть протокола (её снимают и launcher после смерти
  # раннера, и оператор через switch), поэтому «файла нет» — это «активной
  # identity нет» (3), а не «идентити недоверена» (78). Пока это давало 78,
  # `factory <task> runner switch` падал под нагрузкой на ровном месте.
  # Три попытки открытия: одиночный промах между rm и следующим publish — гонка,
  # а не свидетельство подмены; стабильно нечитаемый существующий файл — 78.
  # Открытие обёрнуто в группу: у голого `exec ... 2>/dev/null` редирект stderr
  # применился бы к самой оболочке навсегда, а сообщение о неудачном открытии
  # всё равно ушло бы в лог этапа — редиректы обрабатываются слева направо.
  for attempt in 1 2 3; do
    { exec {fd}<"$file"; } 2>/dev/null && break
    fd=""
    [[ -e "$file" || -L "$file" ]] || return 3
    (( attempt == 3 )) || sleep 0.005
  done
  [[ -n "$fd" ]] || return 78
  uid=$(id -u)
  meta=$(stat -Lc '%u:%a:%h' -- "/proc/self/fd/$fd" 2>/dev/null)
  # Число ссылок 0 — запись сняли ровно в момент открытия: снимок валиден, но
  # активной identity больше нет.
  case "$meta" in
    "$uid:600:1") ;;
    "$uid:600:0") exec {fd}<&-; return 3 ;;
    *) exec {fd}<&-; return 78 ;;
  esac
  mapfile -t lines <&"$fd"
  exec {fd}<&-
  (( ${#lines[@]} == 11 )) || return 78
  [[ "${lines[0]}" == SCHEMA=1 &&
     "${lines[1]}" == TASK="$task" &&
     "${lines[2]}" =~ ^STAGE=([A-Z][A-Z0-9_]*)$ &&
     "${lines[3]}" =~ ^RUN_ID=([A-Za-z0-9._-]+)$ &&
     "${lines[4]}" =~ ^EPOCH=([0-9]+)$ &&
     "${lines[5]}" =~ ^RUNNER=([a-z][a-z0-9_-]*)$ &&
     "${lines[6]}" =~ ^PID=([0-9]+)$ &&
     "${lines[7]}" =~ ^PGID=([0-9]+)$ &&
     "${lines[8]}" =~ ^SESSION=([0-9]+)$ &&
     "${lines[9]}" =~ ^STARTTIME=([0-9]+)$ &&
     "${lines[10]}" == STATE=active ]] || return 78
  local stage=${lines[2]#STAGE=} run_id=${lines[3]#RUN_ID=}
  local epoch=${lines[4]#EPOCH=} runner=${lines[5]#RUNNER=}
  local pid=${lines[6]#PID=} pgid=${lines[7]#PGID=}
  local session=${lines[8]#SESSION=} starttime=${lines[9]#STARTTIME=}
  [[ "$pid" == "$pgid" && "$pid" == "$session" ]] || return 78
  [[ -z "$expected_stage" || "$stage" == "$expected_stage" ]] || return 73
  [[ -z "$expected_run" || "$run_id" == "$expected_run" ]] || return 73
  [[ -z "$expected_epoch" || "$epoch" == "$expected_epoch" ]] || return 73
  printf '%s %s %s %s %s %s %s %s\n' \
    "$stage" "$run_id" "$epoch" "$runner" "$pid" "$pgid" "$session" "$starttime"
}

runner_trusted_identity_publish() {
  local task=${1#[tT]} stage=$2 run_id=$3 epoch=$4 runner=$5
  local pid=$6 pgid=$7 session=$8 starttime=$9
  local file dir tmp existing existing_stage existing_run existing_epoch existing_runner
  local existing_pid existing_pgid existing_session existing_starttime
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ &&
     "$stage" =~ ^[A-Z][A-Z0-9_]*$ &&
     "$run_id" =~ ^[A-Za-z0-9._-]+$ &&
     "$epoch" =~ ^[0-9]+$ &&
     "$runner" =~ ^[a-z][a-z0-9_-]*$ &&
     "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ &&
     "$session" =~ ^[0-9]+$ && "$starttime" =~ ^[0-9]+$ ]] || return 2
  runner_process_full_matches "$pid" "$pgid" "$session" "$starttime" || return 73
  [[ "$pgid" == "$pid" && "$session" == "$pid" ]] || return 76
  _runner_trusted_identity_prepare || return
  file=$(runner_trusted_identity_file "$task") || return
  dir=$(dirname "$file")
  if [[ -e "$file" || -L "$file" ]]; then
    existing=$(runner_trusted_identity_read "$task") || return 78
    read -r existing_stage existing_run existing_epoch existing_runner \
      existing_pid existing_pgid existing_session existing_starttime <<<"$existing"
    if [[ "$existing" == "$stage $run_id $epoch $runner $pid $pgid $session $starttime" ]]; then
      return 0
    fi
    _runner_runtime_present \
      "$existing_pgid" "$existing_session" "$existing_starttime" && return 76
    rm -f -- "$file" || return 1
  fi
  tmp=$(mktemp "$dir/.runner-identity.XXXXXX") || return 1
  {
    printf 'SCHEMA=1\n'
    printf 'TASK=%s\n' "$task"
    printf 'STAGE=%s\n' "$stage"
    printf 'RUN_ID=%s\n' "$run_id"
    printf 'EPOCH=%s\n' "$epoch"
    printf 'RUNNER=%s\n' "$runner"
    printf 'PID=%s\n' "$pid"
    printf 'PGID=%s\n' "$pgid"
    printf 'SESSION=%s\n' "$session"
    printf 'STARTTIME=%s\n' "$starttime"
    printf 'STATE=active\n'
  } >"$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  chmod 600 "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  mv -f -- "$tmp" "$file" || {
    rm -f -- "$tmp"
    return 1
  }
  runner_trusted_identity_read "$task" "$stage" "$run_id" "$epoch" >/dev/null ||
    return 78
  runner_process_full_matches "$pid" "$pgid" "$session" "$starttime" || return 73
}

runner_trusted_identity_clear() {
  local task=${1#[tT]} stage=$2 run_id=$3 epoch=$4 runner=$5
  local pid=$6 pgid=$7 session=$8 starttime=$9 file existing rc
  file=$(runner_trusted_identity_file "$task") || return
  [[ -e "$file" || -L "$file" ]] || return 0
  existing=$(runner_trusted_identity_read "$task" "$stage" "$run_id" "$epoch")
  rc=$?
  # У identity два законных уборщика: launcher — когда раннер умер (`wait` ниже
  # по файлу), и оператор — когда `runner switch` погасил тот же раннер. Они
  # снимают ОДНУ и ту же запись и регулярно встречаются в окне между проверкой
  # выше и этим чтением. Снятие идемпотентно, поэтому «записи уже нет» (3) —
  # успех, а не отказ; чужая (73) и недоверенная (78) identity остаются ошибкой:
  # снимать не своё нельзя. Без этого проигравший гонку отчитывался ошибкой об
  # успешной работе: CLI отдавал 3 после состоявшегося переключения, а launcher
  # ловил group_rc=3 и подменял результат этапа на 76, хотя alpha честно получал TERM,
  # RESULT_CLASS оставался manual_switch и beta доводил этап до done.
  (( rc == 3 )) && return 0
  (( rc == 0 )) || return "$rc"
  [[ "$existing" == "$stage $run_id $epoch $runner $pid $pgid $session $starttime" ]] ||
    return 73
  local browser_binding_root
  browser_binding_root=$(factory_control_root) || return
  rm -f -- "$browser_binding_root/browser-runs/t${task}/${run_id}.json"
  rm -f -- "$file"
}

RUNNER_LAUNCH_ACTIVE_TASK=""
RUNNER_LAUNCH_ACTIVE_PID=""
RUNNER_LAUNCH_ACTIVE_PGID=""
RUNNER_LAUNCH_ACTIVE_SESSION=""
RUNNER_LAUNCH_ACTIVE_STARTTIME=""
RUNNER_LAUNCH_ACTIVE_PUBLISHED=0
RUNNER_LAUNCH_STATE=idle
RUNNER_LAUNCH_DEFERRED_SIGNAL=""

_runner_runtime_usage_dialect() {
  local runner_id=$1 version=${2:-unknown}
  case "$runner_id" in
    codex) printf 'codex-jsonl-v1\n' ;;
    # ACP usage_update — заполненность контекста, не billing counters. Диалект
    # намеренно не зарегистрирован у runtime analytics и остаётся unavailable.
    deepseek) printf 'deepseek-jsonl-unknown\n' ;;
    # Поток wrapper-а GLM несёт только события хода без billing counters: диалект
    # закреплён явно и остаётся unavailable, а не нулевым расходом.
    glm) printf 'glm-jsonl-unknown\n' ;;
    claude)
      if [[ "$version" == 2.1.220 || "$version" == *2.1.220* ]]; then
        printf 'claude-code-jsonl-2.1.220\n'
      else
        # Неизвестные версии намеренно не попадают в закреплённый реестр и приводятся
        # к unsupportedDialect, а не заимствуют семантику версии 2.1.220.
        version=${version//[^A-Za-z0-9._-]/_}
        printf 'claude-code-jsonl-%s\n' "${version:-unknown}"
      fi
      ;;
    *) printf '%s-jsonl-unknown\n' "$runner_id" ;;
  esac
}

_runner_runtime_result_class_valid() {
  case "${1:-}" in
    ok|limited|unavailable_preflight|route_unavailable|manual_switch|agent_failed|\
    provider_unavailable|missing_status|denied|timeout|transient|invalid_config|\
    context_overflow|crashed|runtime_changed|unknown) return 0 ;;
    *) return 1 ;;
  esac
}

_runner_runtime_synthetic_identity() {
  local prefix=$1 task=$2 stage=$3 run_id=$4
  runtime_analytics_id_v2 "$prefix" "standalone" "t$task" "$stage" "$run_id"
}

_runner_runtime_context_write() {
  local output=$1 runner_id=$2 task=$3 stage=$4 run_id=$5 epoch=$6
  local model=$7 effort=$8 run_dir=$9 run_dir_dev=${10} run_dir_ino=${11}
  local events_dev=${12} events_ino=${13} pid=${14} pgid=${15} session=${16}
  local starttime=${17} started_at=${18} quiesced_at=${19} rc=${20}
  local result_class=${21} process_complete=${22} runner_started_hash=${23}
  local provider_mode=${24} requested_scope=${25} parent_ref=${26}
  local lineage_generation=${27} normalizer_parent=${28} status_mode=${29}
  local usage_dir=${30} dialect=${31} resolved_model=${32}
  local attempt visit execution dispatch run_reason
  local -a fields=()

  if runtime_lifecycle_enabled_v2; then
    attempt=$FACTORY_LIFECYCLE_ATTEMPT_ID
    visit=${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}
    execution=${FACTORY_LIFECYCLE_NODE_EXECUTION_ID:-}
    dispatch=${FACTORY_LIFECYCLE_DISPATCH_ID:-}
    [[ "$visit" =~ ^nv_[a-f0-9]{32}$ &&
       "$execution" =~ ^ne_[a-f0-9]{32}$ &&
       "$dispatch" =~ ^d_[a-f0-9]{32}$ ]] || return 78
  else
    attempt=$(_runner_runtime_synthetic_identity a "$task" "$stage" "$run_id") || return
    visit=$(_runner_runtime_synthetic_identity nv "$task" "$stage" "$run_id") || return
    execution=$(_runner_runtime_synthetic_identity ne "$task" "$stage" "$run_id") || return
    dispatch=$(_runner_runtime_synthetic_identity d "$task" "$stage" "$run_id") || return
  fi
  run_reason=${FACTORY_LIFECYCLE_RUN_REASON:-${FACTORY_DEBUG_REASON:-primary}}
  case "$run_reason" in
    primary|provider_failover|model_fallback|manual_switch) ;;
    fallback_limit|fallback_provider_unavailable|unavailable*) run_reason=provider_failover ;;
    *) run_reason=primary ;;
  esac

  fields+=(
    identity.taskId string "t$task"
    identity.attemptId string "$attempt"
    identity.nodeVisitId string "$visit"
    identity.nodeExecutionId string "$execution"
    identity.dispatchId string "$dispatch"
    identity.runId string "$run_id"
    identity.epoch integer "$epoch"
    provider string "$runner_id"
    dialect string "$dialect"
  )
  if [[ -n "$model" ]]; then
    fields+=(requestedModel string "$model")
  else
    fields+=(requestedModel null null)
  fi
  if [[ -n "$resolved_model" ]]; then
    fields+=(resolvedModel string "$resolved_model")
  else
    fields+=(resolvedModel null null)
  fi
  fields+=(
    providerSessionMode string "$provider_mode"
    startedAt string "$started_at"
    quiescedAt string "$quiesced_at"
    processComplete boolean "$process_complete"
    runnerStartedEventHash string "$runner_started_hash"
    usageDirectory string "$usage_dir"
    runDirectoryPath string "$run_dir"
    runDirectoryIdentity.dev string "$run_dir_dev"
    runDirectoryIdentity.ino string "$run_dir_ino"
    eventsIdentity.dev string "$events_dev"
    eventsIdentity.ino string "$events_ino"
    process.pid integer "$pid"
    process.processGroupId integer "$pgid"
    process.sessionId integer "$session"
    process.startTimeTicks string "$starttime"
    runKey string "$stage"
    effort string "$effort"
    runReason string "$run_reason"
    runnerVersion string "${FACTORY_RUNNER_VERSION:-unknown}"
    statusMode string "$status_mode"
    debugLevel string "${DEBUG_LOG_LEVEL:-off}"
    debugSource string "${DEBUG_LOG_SOURCE:-default}"
    rc signed-integer "$rc"
    resultClass string "$result_class"
  )
  if [[ -n "$requested_scope" ]]; then
    fields+=(requestedProviderScope string "$requested_scope")
  else
    fields+=(requestedProviderScope null null)
  fi
  if [[ -n "$parent_ref" && "$parent_ref" != null ]]; then
    fields+=(parentUsageRef json "$parent_ref")
  else
    fields+=(parentUsageRef null null)
  fi
  if [[ -n "$normalizer_parent" && "$normalizer_parent" != null ]]; then
    fields+=(normalizerParentUsage json "$normalizer_parent")
  else
    fields+=(normalizerParentUsage null null)
  fi
  if [[ "$lineage_generation" =~ ^[1-9][0-9]*$ ]]; then
    fields+=(lineageGeneration integer "$lineage_generation")
  else
    fields+=(lineageGeneration null null)
  fi
  runtime_analytics_json_v2 "${fields[@]}" >"$output"
}

_runner_runtime_usage_call() {
  local operation=$1 context=$2 prepared=${3:-} result_class=${4:-}
  local node_bin=${NODE_BIN:-}
  local events_read_fd=${RUNNER_RUNTIME_EVENTS_READ_FD:-}
  local events_write_fd=${RUNNER_RUNTIME_EVENTS_WRITE_FD:-}
  local run_dir_fd=${RUNNER_RUNTIME_RUN_DIR_FD:-}
  [[ -n "$node_bin" && -x "$node_bin" ]] || node_bin=$(command -v node 2>/dev/null) || return 78
  [[ "$run_dir_fd" =~ ^[0-9]+$ ]] || return 78
  case "$operation" in
    prepare)
      [[ "$events_read_fd" =~ ^[0-9]+$ && "$events_write_fd" =~ ^[0-9]+$ ]] || return 78
      "$node_bin" "$FACTORY_HOME/lib/runtime-usage.mjs" prepare "$context" \
        7<&"$events_read_fd" 8>&"$events_write_fd" 9<&"$run_dir_fd"
      ;;
    publish)
      "$node_bin" "$FACTORY_HOME/lib/runtime-usage.mjs" publish "$context" "$prepared" \
        9<&"$run_dir_fd"
      ;;
    invalidate)
      "$node_bin" "$FACTORY_HOME/lib/runtime-usage.mjs" invalidate "$context" "$prepared"
      ;;
    meta-initial)
      "$node_bin" "$FACTORY_HOME/lib/runtime-usage.mjs" meta "$context" initial \
        9<&"$run_dir_fd"
      ;;
    meta-final)
      "$node_bin" "$FACTORY_HOME/lib/runtime-usage.mjs" meta "$context" final "$prepared" "$result_class" \
        9<&"$run_dir_fd"
      ;;
    *) return 2 ;;
  esac
}

_runner_lifecycle_started_v2() {
  local runner_id=$1 run_id=$2 epoch=$3 model=$4 effort=$5 family=$6
  local pid=$7 pgid=$8 session=$9 starttime=${10} provider_mode=${11}
  local requested_scope=${12} parent_ref=${13} reservation=${14} generation=${15}
  local ordinal=${FACTORY_LIFECYCLE_CANDIDATE_ORDINAL:-0} run_reason details process span lifecycle_model
  runtime_lifecycle_enabled_v2 || {
    runtime_analytics_hash_string_v2 "standalone-runner-started:$runner_id:$run_id:$epoch"
    return
  }
  [[ -n "${FACTORY_LIFECYCLE_DISPATCH_ID:-}" ]] || return 78

  lifecycle_model=$(runtime_lifecycle_model_id_v2 "$model") || return

  export FACTORY_LIFECYCLE_RUN_ID=$run_id FACTORY_LIFECYCLE_EPOCH=$epoch
  run_reason=${FACTORY_LIFECYCLE_RUN_REASON:-primary}
  case "$run_reason" in
    primary|provider_failover|model_fallback|manual_switch) ;;
    *) run_reason=primary ;;
  esac
  span=$(runtime_analytics_id_v2 sp "$FACTORY_LIFECYCLE_ATTEMPT_ID" \
    "$FACTORY_LIFECYCLE_DISPATCH_ID" "$run_id" "$epoch" runner) || return
  export FACTORY_LIFECYCLE_SPAN_ID=$span
  process=$(runtime_analytics_json_v2 \
    pid integer "$pid" processGroupId integer "$pgid" sessionId integer "$session" \
    startTimeTicks string "$starttime") || return
  local -a fields=(
    candidateOrdinal integer "$ordinal"
    provider string "$runner_id"
    requestedModel string "$lifecycle_model"
    resolvedModel string "$lifecycle_model"
    effort string "$effort"
    family string "${family:-exact}"
    runReason string "$run_reason"
    providerSessionMode string "$provider_mode"
    invocationContractRevision integer 1
    process json "$process"
    launchBarrier string held
  )
  if [[ -n "$requested_scope" ]]; then
    fields+=(requestedProviderScope string "$requested_scope")
  else
    fields+=(requestedProviderScope null null)
  fi
  if [[ -n "$parent_ref" && "$parent_ref" != null ]]; then
    fields+=(parentUsageRef json "$parent_ref")
  else
    fields+=(parentUsageRef null null)
  fi
  if [[ -n "$reservation" ]]; then
    fields+=(reservationId string "$reservation" lineageGeneration integer "$generation")
  else
    fields+=(reservationId null null lineageGeneration null null)
  fi
  details=$(runtime_analytics_json_v2 "${fields[@]}") || return
  runtime_lifecycle_emit_v2 runner_started "$details" "$run_id:$epoch" "$span"
}

_runner_lifecycle_scope_bound_v2() {
  local runner_id=$1 observed=${2:-} requested=${3:-} evidence=${4:-}
  local match=not_applicable details
  runtime_lifecycle_enabled_v2 || return 0
  if [[ -n "$requested" ]]; then
    if [[ "$requested" == "$observed" ]]; then match=matched; else match=mismatched; fi
  fi
  local -a fields=(
    provider string "$runner_id"
    invocationContractRevision integer 1
    scopeMatch string "$match"
  )
  if [[ -n "$observed" && "$observed" != null ]]; then
    fields+=(observedProviderScope string "$observed")
  else
    fields+=(observedProviderScope null null)
  fi
  if [[ -n "$evidence" ]]; then
    fields+=(scopeEvidenceSha256 string "$evidence")
  else
    fields+=(scopeEvidenceSha256 null null)
  fi
  details=$(runtime_analytics_json_v2 "${fields[@]}") || return
  runtime_lifecycle_emit_v2 runner_scope_bound "$details" \
    "${FACTORY_LIFECYCLE_RUN_ID}:${FACTORY_LIFECYCLE_EPOCH}:scope" -
}

_runner_lifecycle_finished_v2() {
  local result=$1 rc=$2 started_ns=$3 ended_ns=$4 quiesced_at=$5 evidence=$6
  local duration status=succeeded reason=process_exit outcome=exited signal=null details
  runtime_lifecycle_enabled_v2 || return 0
  duration=$(runtime_lifecycle_duration_ms_v2 "$started_ns" "$ended_ns") || return
  if [[ "$result" == timeout || "$rc" == 124 ]]; then
    status=interrupted; reason=timeout; outcome=timed_out
  elif (( rc >= 128 )); then
    status=interrupted; reason=signal; outcome=signalled; signal=$((rc - 128))
  elif [[ "$result" != ok ]]; then
    status=failed
  fi
  details=$(runtime_analytics_json_v2 \
    status string "$status" reasonCode string "$reason" reasonTextSha256 null null \
    durationMs integer "$duration" durationFidelity string monotonic evidenceSha256 null null \
    resultClass string "$result" processOutcome string "$outcome" \
    exitCode integer "$rc" signal "$([[ "$signal" == null ]] && printf null || printf integer)" "$signal" \
    quiescedAt string "$quiesced_at" processSessionQuiesced boolean true \
    quiescenceEvidenceSha256 string "$evidence") || return
  runtime_lifecycle_emit_v2 runner_finished "$details" \
    "${FACTORY_LIFECYCLE_RUN_ID}:${FACTORY_LIFECYCLE_EPOCH}:finish" \
    "$FACTORY_LIFECYCLE_SPAN_ID"
}

_runner_lifecycle_abandoned_v2() {
  local reason=$1 started_ns=$2 ended_ns=$3 quiesced_at=$4 evidence=$5
  local duration details
  runtime_lifecycle_enabled_v2 || return 0
  duration=$(runtime_lifecycle_duration_ms_v2 "$started_ns" "$ended_ns") || return
  details=$(runtime_analytics_json_v2 \
    status string abandoned reasonCode string crash reasonTextSha256 null null \
    durationMs integer "$duration" durationFidelity string monotonic evidenceSha256 null null \
    abandonmentReason string "$reason" quiescedAt string "$quiesced_at" \
    processSessionQuiesced boolean true quiescenceEvidenceSha256 string "$evidence") || return
  runtime_lifecycle_emit_v2 runner_abandoned "$details" \
    "${FACTORY_LIFECYCLE_RUN_ID}:${FACTORY_LIFECYCLE_EPOCH}:abandoned" \
    "$FACTORY_LIFECYCLE_SPAN_ID"
}

_runner_lifecycle_usage_v2() {
  local publication=$1 details checkpoint_type checkpoint
  runtime_lifecycle_enabled_v2 || return 0
  checkpoint=$(runtime_analytics_json_get_v2 "$publication" checkpointHash 2>/dev/null || printf null)
  if [[ "$checkpoint" == null || -z "$checkpoint" ]]; then checkpoint_type=null; else checkpoint_type=string; fi
  details=$(runtime_analytics_json_v2 \
    documentSha256 string "$(runtime_analytics_json_get_v2 "$publication" documentHash)" \
    documentSizeBytes integer "$(runtime_analytics_json_get_v2 "$publication" documentSizeBytes)" \
    source string "$(runtime_analytics_json_get_v2 "$publication" source)" \
    completeness string "$(runtime_analytics_json_get_v2 "$publication" completeness)" \
    coverage.acceptedSegmentCount integer "$(runtime_analytics_json_get_v2 "$publication" acceptedSegmentCount)" \
    coverage.rejectedSampleCount integer "$(runtime_analytics_json_get_v2 "$publication" rejectedSampleCount)" \
    coverage.linkCoverage string exact \
    coverage.diagnosticCodes json "$(runtime_analytics_json_get_v2 "$publication" diagnosticCodes)" \
    checkpointHash "$checkpoint_type" "$checkpoint" \
    resumeEligible boolean "$(runtime_analytics_json_get_v2 "$publication" resumeEligible)") || return
  runtime_lifecycle_emit_v2 runner_usage_recorded "$details" \
    "${FACTORY_LIFECYCLE_RUN_ID}:${FACTORY_LIFECYCLE_EPOCH}:usage" -
}

RUNNER_LINEAGE_MODE=fresh
RUNNER_LINEAGE_SCOPE=""
RUNNER_LINEAGE_RESERVATION=""
RUNNER_LINEAGE_GENERATION=""
RUNNER_LINEAGE_REVISION=""
RUNNER_LINEAGE_PARENT_REF=null
RUNNER_LINEAGE_NORMALIZER_PARENT=null
RUNNER_LINEAGE_STARTED=0

_runner_lineage_reset_v2() {
  RUNNER_LINEAGE_MODE=${FACTORY_PROVIDER_SESSION_MODE:-fresh}
  RUNNER_LINEAGE_SCOPE=${FACTORY_PROVIDER_REQUESTED_SCOPE:-}
  RUNNER_LINEAGE_RESERVATION=""
  RUNNER_LINEAGE_GENERATION=""
  RUNNER_LINEAGE_REVISION=""
  RUNNER_LINEAGE_PARENT_REF=null
  RUNNER_LINEAGE_NORMALIZER_PARENT=null
  RUNNER_LINEAGE_STARTED=0
}

_runner_lineage_reserve_v2() {
  local provider=$1 run_id=$2 capabilities=$3 usage_dir=$4 dialect=$5
  local root record request output state revision generation predecessor document checkpoint
  local usage_event scope_event parent_path
  _runner_lineage_reset_v2
  case "$RUNNER_LINEAGE_MODE" in
    fresh)
      [[ -z "$RUNNER_LINEAGE_SCOPE" ]] || return 78
      return 0
      ;;
    resume) ;;
    *) return 78 ;;
  esac
  [[ " $capabilities " == *" native_resume_v1 "* &&
     -n "$RUNNER_LINEAGE_SCOPE" ]] || return 78
  root=$(factory_control_root) || return
  record=$(mktemp "$root/.provider-lineage-read.XXXXXX") || return 1
  request=$(mktemp "$root/.provider-lineage-request.XXXXXX") || {
    rm -f -- "$record"
    return 1
  }
  output=$(provider_lineage_read_v1 "$provider" "$RUNNER_LINEAGE_SCOPE" >"$record")
  local rc=$?
  if (( rc != 0 )); then
    rm -f -- "$record" "$request"
    return "$rc"
  fi
  state=$(runtime_analytics_json_get_v2 "$record" state) || rc=$?
  revision=$(runtime_analytics_json_get_v2 "$record" stateRevision) || rc=$?
  generation=$(runtime_analytics_json_get_v2 "$record" lineageGeneration) || rc=$?
  predecessor=$(runtime_analytics_json_get_v2 "$record" predecessorRunId) || rc=$?
  document=$(runtime_analytics_json_get_v2 "$record" predecessorUsageDocumentHash) || rc=$?
  checkpoint=$(runtime_analytics_json_get_v2 "$record" predecessorCheckpointHash) || rc=$?
  usage_event=$(runtime_analytics_json_get_v2 "$record" predecessorRunnerUsageRecordedEventHash) || rc=$?
  scope_event=$(runtime_analytics_json_get_v2 "$record" predecessorScopeBoundEventHash) || rc=$?
  if (( rc != 0 )) || [[ "$state" != advanced || ! "$revision" =~ ^[1-9][0-9]*$ ||
       ! "$generation" =~ ^[0-9]+$ || ! "$predecessor" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ||
       ! "$document" =~ ^[a-f0-9]{64}$ || ! "$checkpoint" =~ ^[a-f0-9]{64}$ ]]; then
    rm -f -- "$record" "$request"
    return 75
  fi
  RUNNER_LINEAGE_GENERATION=$((generation + 1))
  RUNNER_LINEAGE_RESERVATION=$(runtime_analytics_id_v2 lr \
    "$provider" "$RUNNER_LINEAGE_SCOPE" "$predecessor" "$run_id" \
    "$RUNNER_LINEAGE_GENERATION") || rc=$?
  RUNNER_LINEAGE_PARENT_REF=$(runtime_analytics_json_v2 \
    runId string "$predecessor" documentHash string "$document" \
    checkpointHash string "$checkpoint" provider string "$provider" \
    normalizerDialect string "$dialect") || rc=$?
  parent_path="$usage_dir/$predecessor.json"
  RUNNER_LINEAGE_NORMALIZER_PARENT=$(runtime_analytics_python_v2 parent-usage \
    "$parent_path" "$document" "$predecessor" "$checkpoint" "$provider" "$dialect" \
    "$RUNNER_LINEAGE_SCOPE") || rc=$?
  if (( rc != 0 )); then
    rm -f -- "$record" "$request"
    return "$rc"
  fi
  runtime_analytics_json_v2 \
    schemaVersion integer 1 protocolVersion integer 2 \
    provider string "$provider" threadId string "$RUNNER_LINEAGE_SCOPE" \
    expectedStateRevision integer "$revision" \
    lineageGeneration integer "$RUNNER_LINEAGE_GENERATION" \
    predecessorRunId string "$predecessor" \
    predecessorUsageDocumentHash string "$document" \
    predecessorCheckpointHash string "$checkpoint" \
    reservationId string "$RUNNER_LINEAGE_RESERVATION" \
    childRunId string "$run_id" >"$request" || rc=$?
  if (( rc == 0 )); then
    provider_lineage_reserve_v1 "$request" >"$record" || rc=$?
  fi
  if (( rc == 0 )); then
    RUNNER_LINEAGE_REVISION=$(runtime_analytics_json_get_v2 "$record" stateRevision) || rc=$?
  fi
  rm -f -- "$record" "$request"
  (( rc == 0 )) || return "$rc"
  export FACTORY_PROVIDER_RESUME_SCOPE=$RUNNER_LINEAGE_SCOPE
  export FACTORY_PROVIDER_SESSION_MODE=resume
  export FACTORY_PROVIDER_LINEAGE_GENERATION=$RUNNER_LINEAGE_GENERATION
  export FACTORY_PROVIDER_PARENT_USAGE_REF=$RUNNER_LINEAGE_PARENT_REF
}

_runner_lineage_mark_started_v2() {
  local provider=$1 run_id=$2 event_hash=$3 root request output rc
  [[ "$RUNNER_LINEAGE_MODE" == resume ]] || return 0
  root=$(factory_control_root) || return
  request=$(mktemp "$root/.provider-lineage-started.XXXXXX") || return 1
  output=$(mktemp "$root/.provider-lineage-result.XXXXXX") || {
    rm -f -- "$request"
    return 1
  }
  runtime_analytics_json_v2 \
    schemaVersion integer 1 protocolVersion integer 2 provider string "$provider" \
    threadId string "$RUNNER_LINEAGE_SCOPE" \
    expectedStateRevision integer "$RUNNER_LINEAGE_REVISION" \
    reservationId string "$RUNNER_LINEAGE_RESERVATION" childRunId string "$run_id" \
    runnerStartedEventHash string "$event_hash" >"$request" || rc=$?
  if (( ${rc:-0} == 0 )); then
    provider_lineage_mark_started_v1 "$request" >"$output" || rc=$?
  fi
  if (( ${rc:-0} == 0 )); then
    RUNNER_LINEAGE_REVISION=$(runtime_analytics_json_get_v2 "$output" stateRevision) || rc=$?
  fi
  rm -f -- "$request" "$output"
  (( ${rc:-0} == 0 )) || return "$rc"
  RUNNER_LINEAGE_STARTED=1
}

_runner_lineage_cancel_v2() {
  local provider=$1 run_id=$2 never_hash=$3 quiescence_hash=$4 root request rc=0
  [[ "$RUNNER_LINEAGE_MODE" == resume && "$RUNNER_LINEAGE_STARTED" == 0 &&
     -n "$RUNNER_LINEAGE_RESERVATION" ]] || return 0
  root=$(factory_control_root) || return
  request=$(mktemp "$root/.provider-lineage-cancel.XXXXXX") || return 1
  runtime_analytics_json_v2 \
    schemaVersion integer 1 protocolVersion integer 2 provider string "$provider" \
    threadId string "$RUNNER_LINEAGE_SCOPE" expectedStateRevision integer "$RUNNER_LINEAGE_REVISION" \
    reservationId string "$RUNNER_LINEAGE_RESERVATION" childRunId string "$run_id" \
    cancellationProof.neverReleased boolean true \
    cancellationProof.processSessionQuiesced boolean true \
    cancellationProof.neverReleasedEvidenceHash string "$never_hash" \
    cancellationProof.quiescenceEvidenceHash string "$quiescence_hash" >"$request" || rc=$?
  (( rc != 0 )) || provider_lineage_cancel_v1 "$request" >/dev/null || rc=$?
  rm -f -- "$request"
  return "$rc"
}

_runner_lineage_block_v2() {
  local provider=$1 run_id=$2 reason=$3 evidence=$4 root request rc=0
  [[ "$RUNNER_LINEAGE_MODE" == resume && "$RUNNER_LINEAGE_STARTED" == 1 ]] || return 0
  root=$(factory_control_root) || return
  request=$(mktemp "$root/.provider-lineage-block.XXXXXX") || return 1
  runtime_analytics_json_v2 \
    schemaVersion integer 1 protocolVersion integer 2 provider string "$provider" \
    threadId string "$RUNNER_LINEAGE_SCOPE" expectedStateRevision integer "$RUNNER_LINEAGE_REVISION" \
    reservationId string "$RUNNER_LINEAGE_RESERVATION" childRunId string "$run_id" \
    blockProof.reasonCode string "$reason" blockProof.evidenceHash string "$evidence" \
    >"$request" || rc=$?
  (( rc != 0 )) || provider_lineage_block_v1 "$request" >/dev/null || rc=$?
  rm -f -- "$request"
  return "$rc"
}

_runner_lineage_commit_usage_v2() {
  local provider=$1 run_id=$2 publication=$3 usage_event_hash=$4 scope_event_hash=$5
  local observed completeness eligible checkpoint document root request output rc=0
  observed=$(runtime_analytics_json_get_v2 "$publication" observedProviderScope 2>/dev/null || true)
  [[ "$observed" != null ]] || observed=""
  completeness=$(runtime_analytics_json_get_v2 "$publication" completeness) || return
  eligible=$(runtime_analytics_json_get_v2 "$publication" resumeEligible) || return
  checkpoint=$(runtime_analytics_json_get_v2 "$publication" checkpointHash 2>/dev/null || true)
  document=$(runtime_analytics_json_get_v2 "$publication" documentHash) || return
  [[ "$completeness" == complete && "$eligible" == true &&
     "$checkpoint" =~ ^[a-f0-9]{64}$ && -n "$observed" ]] || {
    if [[ "$RUNNER_LINEAGE_MODE" == resume && "$RUNNER_LINEAGE_STARTED" == 1 ]]; then
      _runner_lineage_block_v2 "$provider" "$run_id" missing_complete_usage "$document"
    fi
    return 0
  }
  root=$(factory_control_root) || return
  request=$(mktemp "$root/.provider-lineage-commit.XXXXXX") || return 1
  output=$(mktemp "$root/.provider-lineage-result.XXXXXX") || {
    rm -f -- "$request"
    return 1
  }
  if [[ "$RUNNER_LINEAGE_MODE" == resume ]]; then
    [[ "$observed" == "$RUNNER_LINEAGE_SCOPE" ]] || {
      rm -f -- "$request" "$output"
      _runner_lineage_block_v2 "$provider" "$run_id" scope_conflict "$document"
      return
    }
    runtime_analytics_json_v2 \
      schemaVersion integer 1 protocolVersion integer 2 provider string "$provider" \
      threadId string "$observed" expectedStateRevision integer "$RUNNER_LINEAGE_REVISION" \
      reservationId string "$RUNNER_LINEAGE_RESERVATION" childRunId string "$run_id" \
      usageDocumentHash string "$document" checkpointHash string "$checkpoint" \
      runnerUsageRecordedEventHash string "$usage_event_hash" \
      runnerScopeBoundEventHash string "$scope_event_hash" \
      usageCompleteness string complete resumeEligible boolean true >"$request" || rc=$?
    (( rc != 0 )) || provider_lineage_advance_v1 "$request" >"$output" || rc=$?
  else
    runtime_analytics_json_v2 \
      schemaVersion integer 1 protocolVersion integer 2 provider string "$provider" \
      threadId string "$observed" lineageGeneration integer 0 runId string "$run_id" \
      usageDocumentHash string "$document" checkpointHash string "$checkpoint" \
      runnerUsageRecordedEventHash string "$usage_event_hash" \
      runnerScopeBoundEventHash string "$scope_event_hash" \
      usageCompleteness string complete resumeEligible boolean true >"$request" || rc=$?
    (( rc != 0 )) || provider_lineage_initialize_advanced_v1 "$request" >"$output" || rc=$?
  fi
  rm -f -- "$request" "$output"
  return "$rc"
}

_runner_lineage_scope_guard_v2() {
  local provider=$1 prepared=$2 replacement=$3 observed record root rc state predecessor
  observed=$(runtime_analytics_json_get_v2 "$prepared" observedProviderScope 2>/dev/null || true)
  [[ "$observed" != null ]] || observed=""
  if [[ "$RUNNER_LINEAGE_MODE" == resume ]]; then
    [[ -n "$observed" && "$observed" == "$RUNNER_LINEAGE_SCOPE" ]] && return 0
    _runner_runtime_usage_call invalidate "$prepared" counterScopeConflict >"$replacement"
    return
  fi
  [[ -n "$observed" ]] || return 0
  root=$(factory_control_root) || return
  record=$(mktemp "$root/.provider-lineage-scope.XXXXXX") || return 1
  provider_lineage_read_v1 "$provider" "$observed" >"$record"
  rc=$?
  if (( rc == 3 )); then
    rm -f -- "$record"
    return 0
  fi
  if (( rc == 0 )); then
    state=$(runtime_analytics_json_get_v2 "$record" state 2>/dev/null || true)
    predecessor=$(runtime_analytics_json_get_v2 "$record" predecessorRunId 2>/dev/null || true)
    if [[ "$state" == advanced && "$predecessor" == "${FACTORY_LIFECYCLE_RUN_ID:-}" ]]; then
      rm -f -- "$record"
      return 0
    fi
  fi
  rm -f -- "$record"
  _runner_runtime_usage_call invalidate "$prepared" counterScopeConflict >"$replacement"
}

_runner_launch_restore_signal_traps() {
  local saved_term=$1 saved_int=$2 pending
  if [[ -n "$saved_term" ]]; then
    eval "$saved_term"
  else
    trap - TERM
  fi
  if [[ -n "$saved_int" ]]; then
    eval "$saved_int"
  else
    trap - INT
  fi
  # Отложенный слот читается только после восстановления обоих исходных trap. Сигнал,
  # пришедший между последней командой вызывающей стороны и любым из восстановлений,
  # нельзя стереть более ранним снимком этой переменной.
  pending=$RUNNER_LAUNCH_DEFERRED_SIGNAL
  RUNNER_LAUNCH_DEFERRED_SIGNAL=""
  [[ -z "$pending" ]] || kill -s "$pending" "$BASHPID"
}

runner_inflight_barrier_quiesce() {
  local task=${1#[tT]} grace_s=${2:-5} identity
  local pgid session starttime state ppid
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ && "$grace_s" =~ ^[0-9]+$ ]] || return 2
  case "$RUNNER_LAUNCH_STATE" in
    idle) return 3 ;;
    preparing)
      # Сигнал пришёл в критической секции fork/публикации. Отсутствие PID не доказывает,
      # что fork не произошёл; закрываемся отказом и не трогаем базовую линию инструментации.
      return 79
      ;;
    barrier|published|running|quiescing) ;;
    *) return 78 ;;
  esac
  [[ "$RUNNER_LAUNCH_ACTIVE_TASK" == "$task" &&
     "$RUNNER_LAUNCH_ACTIVE_PID" =~ ^[0-9]+$ ]] || return 3
  if ! kill -0 "$RUNNER_LAUNCH_ACTIVE_PID" 2>/dev/null; then
    wait "$RUNNER_LAUNCH_ACTIVE_PID" 2>/dev/null || true
    return 0
  fi
  identity=$(_runner_process_full_identity "$RUNNER_LAUNCH_ACTIVE_PID") || return 73
  read -r pgid session starttime state ppid <<<"$identity"
  [[ "$ppid" == "$BASHPID" &&
     "$pgid" != "$(ps -o pgid= -p "$BASHPID" 2>/dev/null | tr -d ' ')" ]] ||
    return 73
  _runner_quiesce_owned_runtime \
    "$RUNNER_LAUNCH_ACTIVE_PID" "$pgid" "$session" "$starttime" "$grace_s"
}

_runner_terminate_barrier_child() {
  local pid=${1:?pid} identity pgid session starttime state ppid own_pgid poll
  identity=$(_runner_process_full_identity "$pid") || {
    wait "$pid" 2>/dev/null || true
    return 0
  }
  read -r pgid session starttime state ppid <<<"$identity"
  own_pgid=$(ps -o pgid= -p "$BASHPID" 2>/dev/null | tr -d ' ')
  if [[ -n "$own_pgid" && "$pgid" == "$own_pgid" ]]; then
    # Unit-тест может передать остановленного обычного потомка вместо setsid-раннера.
    # В таком случае нельзя посылать сигнал собственной группе процессов запускателя.
    kill -CONT "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    for poll in {1..100}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.01
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  else
    _runner_quiesce_owned_runtime "$pid" "$pgid" "$session" "$starttime" 1
  fi
  wait "$pid" 2>/dev/null || true
}

_runner_launch_close_telemetry_fds_v2() {
  if [[ "${RUNNER_RUNTIME_EVENTS_READ_FD:-}" =~ ^[0-9]+$ ]]; then
    exec {RUNNER_RUNTIME_EVENTS_READ_FD}<&- 2>/dev/null || true
  fi
  if [[ "${RUNNER_RUNTIME_EVENTS_WRITE_FD:-}" =~ ^[0-9]+$ ]]; then
    exec {RUNNER_RUNTIME_EVENTS_WRITE_FD}>&- 2>/dev/null || true
  fi
  if [[ "${RUNNER_RUNTIME_RUN_DIR_FD:-}" =~ ^[0-9]+$ ]]; then
    exec {RUNNER_RUNTIME_RUN_DIR_FD}<&- 2>/dev/null || true
  fi
  unset RUNNER_RUNTIME_EVENTS_READ_FD RUNNER_RUNTIME_EVENTS_WRITE_FD RUNNER_RUNTIME_RUN_DIR_FD
}

_runner_launch_reset_active_v2() {
  RUNNER_LAUNCH_ACTIVE_TASK=""
  RUNNER_LAUNCH_ACTIVE_PID=""
  RUNNER_LAUNCH_ACTIVE_PGID=""
  RUNNER_LAUNCH_ACTIVE_SESSION=""
  RUNNER_LAUNCH_ACTIVE_STARTTIME=""
  RUNNER_LAUNCH_ACTIVE_PUBLISHED=0
  RUNNER_LAUNCH_STATE=idle
}

_runner_launch_fault_v2() {
  local point=$1
  [[ "${FACTORY_TESTING:-0}" == 1 ]] || return 0
  [[ -z "${FACTORY_RUNNER_LAUNCH_FAULT:-}" ||
     "$FACTORY_RUNNER_LAUNCH_FAULT" != "$point" ]] || return 91
}

_runner_launch_held_cleanup_v2() {
  browser_transport_stop
  local token_fd=${1:-} saved_term=${2:-} saved_int=${3:-} context_file=${4:-}
  if [[ "$token_fd" =~ ^[0-9]+$ ]]; then
    exec {token_fd}<&- 2>/dev/null || true
  fi
  [[ -z "$context_file" ]] || rm -f -- "$context_file"
  _runner_launch_reset_active_v2
  _runner_launch_close_telemetry_fds_v2
  # Восстанавливаем последним: отложенный сигнал может немедленно вызвать trap вызывающего.
  _runner_launch_restore_signal_traps "$saved_term" "$saved_int"
}

_runner_launch_pre_release_abort_v2() {
  browser_transport_stop
  local runner_id=$1 task=$2 stage=$3 run_id=$4 epoch=$5 pid=$6 pgid=$7
  local session=$8 starttime=$9 started_ns=${10:-0} lifecycle_started=${11:-0}
  local quiesced_at quiesced_ns clock_boot evidence never_evidence
  _runner_terminate_barrier_child "$pid"
  IFS=$'\t' read -r quiesced_at quiesced_ns clock_boot < <(runtime_analytics_now_v2) || return 78
  evidence=$(runtime_analytics_hash_string_v2 \
    "quiesced:$runner_id:$task:$stage:$run_id:$epoch:$pid:$pgid:$session:$starttime:$quiesced_ns") || return
  never_evidence=$(runtime_analytics_hash_string_v2 \
    "never-released:$runner_id:$task:$stage:$run_id:$epoch:$pid:$starttime") || return
  if [[ "$RUNNER_LINEAGE_STARTED" == 1 ]]; then
    _runner_lineage_block_v2 "$runner_id" "$run_id" checkpoint_ineligible "$evidence" || true
  else
    _runner_lineage_cancel_v2 "$runner_id" "$run_id" "$never_evidence" "$evidence" || true
  fi
  if [[ "$lifecycle_started" == 1 && "$started_ns" =~ ^[0-9]+$ ]]; then
    _runner_lifecycle_abandoned_v2 pre_release_failure "$started_ns" "$quiesced_ns" \
      "$quiesced_at" "$evidence" >/dev/null || true
  fi
  runner_trusted_identity_clear \
    "$task" "$stage" "$run_id" "$epoch" "$runner_id" \
    "$pid" "$pgid" "$session" "$starttime" 2>/dev/null || true
}

runner_launch() {
  local runner_id=$1 task=$2 prompt=$3 stage=$4 model=$5 effort=$6 timeout_s=$7
  local run_dir=$8 run_id=$9 epoch=${10} status_token=${11}
  local module control_root token_file token_fd pid identity pgid session starttime process_ppid
  local rc result_class own_pgid group_rc=0
  local saved_term_trap="" saved_int_trap=""
  local capabilities status_mode=status_fd request_dir="" request_rc=0 consume_rc=0
  local terminal_state=""
  local run_parent run_dir_fd events_write_fd events_read_fd old_umask noclobber_was_on=0
  local run_dir_dev run_dir_ino events_dev events_ino usage_dir dialect context_file=""
  local prepared_file="" replacement_file="" publication_file="" event_output=""
  local started_at started_ns clock_boot quiesced_at quiesced_ns quiescence_evidence
  local runner_started_hash scope_event_hash finished_event_hash usage_event_hash
  local observed_scope="" source_evidence="" process_complete=false analytics_enabled=0
  local provider_mode requested_scope parent_ref normalizer_parent lineage_generation
  local source_rc=0 lifecycle_rc=0 analytics_rc=0 meta_rc=0 reconcile_rc=0 publication_ready=0
  local family=${FACTORY_DEBUG_FAMILY:-exact}
  RUNNER_LAUNCH_LAST_STARTED=0
  BROWSER_TRANSPORT_ERROR=""
  module=$(runner_module_path "$runner_id") || return 2
  runner_contract_check "$runner_id" || return 2
  run_parent=$(dirname -- "$run_dir")
  mkdir -p -- "$run_parent" || return 1
  chmod 700 -- "$run_parent" 2>/dev/null || true
  if ! mkdir -m 700 -- "$run_dir" 2>/dev/null; then
    echo "runner launcher refused existing run directory: $run_dir" >&2
    return 73
  fi
  run_dir=$(realpath -e -- "$run_dir" 2>/dev/null) || return 78
  [[ -d "$run_dir" && ! -L "$run_dir" ]] || return 78
  exec {run_dir_fd}<"$run_dir" || return 1
  RUNNER_RUNTIME_RUN_DIR_FD=$run_dir_fd
  export RUNNER_RUNTIME_RUN_DIR_FD
  read -r run_dir_dev run_dir_ino < <(stat -Lc '%d %i' "/proc/self/fd/$run_dir_fd") || {
    _runner_launch_close_telemetry_fds_v2
    return 78
  }

  old_umask=$(umask)
  umask 077
  [[ -o noclobber ]] && noclobber_was_on=1
  set -o noclobber
  if ! { exec {events_write_fd}>"/proc/self/fd/$run_dir_fd/events.jsonl"; } 2>/dev/null; then
    (( noclobber_was_on == 1 )) || set +o noclobber
    umask "$old_umask"
    exec {run_dir_fd}<&-
    return 73
  fi
  (( noclobber_was_on == 1 )) || set +o noclobber
  umask "$old_umask"
  chmod 600 -- "/proc/self/fd/$events_write_fd" 2>/dev/null || {
    exec {events_write_fd}>&-
    exec {run_dir_fd}<&-
    return 1
  }
  exec {events_read_fd}<"/proc/self/fd/$events_write_fd" || {
    exec {events_write_fd}>&-
    exec {run_dir_fd}<&-
    return 1
  }
  RUNNER_RUNTIME_EVENTS_READ_FD=$events_read_fd
  RUNNER_RUNTIME_EVENTS_WRITE_FD=$events_write_fd
  export RUNNER_RUNTIME_EVENTS_READ_FD RUNNER_RUNTIME_EVENTS_WRITE_FD
  read -r events_dev events_ino < <(stat -Lc '%d %i' "/proc/self/fd/$events_read_fd") || {
    _runner_launch_close_telemetry_fds_v2
    return 78
  }
  [[ "$events_dev:$events_ino" == "$(stat -c '%d:%i' "$run_dir/events.jsonl" 2>/dev/null)" &&
     -f "/proc/self/fd/$events_read_fd" &&
     "$(stat -Lc '%a:%h' "/proc/self/fd/$events_read_fd" 2>/dev/null)" == "600:1" ]] || {
    _runner_launch_close_telemetry_fds_v2
    return 78
  }
  : >"/proc/self/fd/$run_dir_fd/stderr.log" || {
    _runner_launch_close_telemetry_fds_v2
    return 1
  }
  chmod 600 -- "/proc/self/fd/$run_dir_fd/stderr.log" 2>/dev/null || true
  capabilities=$(runner_call "$runner_id" capabilities 2>/dev/null || true)
  if [[ " $capabilities " == *" status_request "* ]]; then
    status_mode=request
    request_dir="$run_dir/control-requests"
    mkdir -p "$request_dir"
    chmod 700 "$request_dir" 2>/dev/null || true
  fi

  # CLI фабрики экспортирует FACTORY_CONFIG_ROOT, но launcher остаётся пригодным
  # для отдельного вызова/контрактного теста: персональный default не должен
  # превращать отсутствие необязательной env-переменной в падение до provider.
  local config_root="${FACTORY_CONFIG_ROOT:-${HOME:?HOME or FACTORY_CONFIG_ROOT is required}/.factory/config}"
  # Функции Bash используют динамическую область видимости, поэтому вызванные позже
  # helpers доверенной идентичности видят тот же резервный корень, даже если отдельный
  # вызывающий процесс не экспортировал FACTORY_CONFIG_ROOT.
  local FACTORY_CONFIG_ROOT="${FACTORY_CONFIG_ROOT:-$config_root}"
  control_root=$(factory_control_root) || {
    _runner_launch_close_telemetry_fds_v2
    return 78
  }
  mkdir -p "$control_root/tokens" || {
    _runner_launch_close_telemetry_fds_v2
    return 1
  }
  [[ ! -L "$control_root" && "$(realpath -e -- "$control_root" 2>/dev/null)" == "$control_root" ]] ||
    { _runner_launch_close_telemetry_fds_v2; return 78; }
  chmod 700 "$control_root" "$control_root/tokens" 2>/dev/null || true
  token_file=$(mktemp "$control_root/tokens/.capability.XXXXXX") || {
    _runner_launch_close_telemetry_fds_v2
    return 1
  }
  chmod 600 "$token_file" && printf '%s\n' "$status_token" >"$token_file" &&
    exec {token_fd}<"$token_file" || {
      rc=$?
      rm -f -- "$token_file"
      _runner_launch_close_telemetry_fds_v2
      return "$rc"
    }
  rm -f -- "$token_file"

  runtime_lifecycle_enabled_v2 && analytics_enabled=1
  if (( analytics_enabled )); then
    usage_dir="$(attempt_state_v2_task_root "$task")/attempts/$FACTORY_LIFECYCLE_ATTEMPT_ID/lifecycle/usage"
  else
    usage_dir="$control_root/runtime-usage-unlinked"
  fi
  dialect=$(_runner_runtime_usage_dialect \
    "$runner_id" "${FACTORY_RUNNER_VERSION:-unknown}") || {
      rc=$?
      exec {token_fd}<&-
      _runner_launch_close_telemetry_fds_v2
      return "$rc"
    }
  _runner_lineage_reserve_v2 "$runner_id" "$run_id" "$capabilities" "$usage_dir" "$dialect" || {
    rc=$?
    exec {token_fd}<&-
    exec {events_read_fd}<&-
    exec {events_write_fd}>&-
    exec {run_dir_fd}<&-
    return "$rc"
  }
  provider_mode=$RUNNER_LINEAGE_MODE
  requested_scope=$RUNNER_LINEAGE_SCOPE
  parent_ref=$RUNNER_LINEAGE_PARENT_REF
  normalizer_parent=$RUNNER_LINEAGE_NORMALIZER_PARENT
  lineage_generation=$RUNNER_LINEAGE_GENERATION

  factory_exec_check local setsid || {
    exec {token_fd}<&-
    exec {events_read_fd}<&-
    exec {events_write_fd}>&-
    exec {run_dir_fd}<&-
    return 126
  }
  RUNNER_LAUNCH_ACTIVE_TASK=$task
  RUNNER_LAUNCH_ACTIVE_PID=""
  RUNNER_LAUNCH_ACTIVE_PGID=""
  RUNNER_LAUNCH_ACTIVE_SESSION=""
  RUNNER_LAUNCH_ACTIVE_STARTTIME=""
  RUNNER_LAUNCH_ACTIVE_PUBLISHED=0
  RUNNER_LAUNCH_STATE=preparing
  RUNNER_LAUNCH_DEFERRED_SIGNAL=""
  saved_term_trap=$(trap -p TERM)
  saved_int_trap=$(trap -p INT)
  trap 'RUNNER_LAUNCH_DEFERRED_SIGNAL=${RUNNER_LAUNCH_DEFERRED_SIGNAL:-TERM}' TERM
  trap 'RUNNER_LAUNCH_DEFERRED_SIGNAL=${RUNNER_LAUNCH_DEFERRED_SIGNAL:-INT}' INT
  browser_transport_prepare "$task" "$stage" "$run_id" "$epoch" "$request_dir" "$token_fd" || {
    rc=$?
    # Резервация lineage уже сделана, но fork ещё не происходил.
    # Отмена с доказательством never-started сохраняет право на следующий resume.
    quiescence_evidence=$(runtime_analytics_hash_string_v2 \
      "browser-prepare-never-started:$runner_id:$task:$stage:$run_id:$epoch") || true
    _runner_lineage_cancel_v2 "$runner_id" "$run_id" \
      "$quiescence_evidence" "$quiescence_evidence" || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" ""
    return "$rc"
  }
  FACTORY_LAUNCH_BARRIER=1 \
  FACTORY_RUN_TASK="$task" FACTORY_RUN_STAGE="$stage" \
  FACTORY_RUN_ID="$run_id" FACTORY_RUN_EPOCH="$epoch" \
  FACTORY_PROVIDER_SESSION_MODE="$provider_mode" \
  FACTORY_PROVIDER_RESUME_SCOPE="$requested_scope" \
  FACTORY_PROVIDER_LINEAGE_GENERATION="$lineage_generation" \
  FACTORY_PROVIDER_PARENT_USAGE_REF="$parent_ref" \
  FACTORY_STATUS_MODE="$status_mode" FACTORY_STATUS_REQUEST_DIR="$request_dir" \
  setsid bash "$FACTORY_HOME/lib/runner-bridge.sh" "$module" "$runner_id" run \
    "$task" "$prompt" "$stage" "$model" "$effort" "$timeout_s" "$run_dir" \
    7<&"$token_fd" >&"$events_write_fd" 2>"/proc/self/fd/$run_dir_fd/stderr.log" &
  pid=$!
  RUNNER_LAUNCH_ACTIVE_PID=$pid
  RUNNER_LAUNCH_STATE=barrier

  identity=""
  local poll process_state=""
  for poll in {1..100}; do
    identity=$(_runner_process_full_identity "$pid") || identity=""
    if [[ -n "$identity" ]]; then
      read -r pgid session starttime process_state process_ppid <<<"$identity"
    else
      process_state=""
    fi
    [[ -n "$identity" && "$process_state" == T ]] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.01
  done
  if [[ -z "$identity" || "$process_state" != T ]]; then
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid"; rc=$?
    quiescence_evidence=$(runtime_analytics_hash_string_v2 \
      "barrier-not-reached:$runner_id:$task:$stage:$run_id:$epoch:$pid") || true
    _runner_lineage_cancel_v2 "$runner_id" "$run_id" \
      "${quiescence_evidence:-$(printf barrier | sha256sum | awk '{print $1}')}" \
      "${quiescence_evidence:-$(printf quiesced | sha256sum | awk '{print $1}')}" || true
    exec {token_fd}<&-
    RUNNER_LAUNCH_ACTIVE_TASK=""
    RUNNER_LAUNCH_ACTIVE_PID=""
    RUNNER_LAUNCH_STATE=idle
    _runner_launch_restore_signal_traps \
      "$saved_term_trap" "$saved_int_trap"
    _runner_launch_close_telemetry_fds_v2
    return "$rc"
  fi
  read -r pgid session starttime process_state process_ppid <<<"$identity"
  RUNNER_LAUNCH_ACTIVE_PGID=$pgid
  RUNNER_LAUNCH_ACTIVE_SESSION=$session
  RUNNER_LAUNCH_ACTIVE_STARTTIME=$starttime
  own_pgid=$(ps -o pgid= -p "$BASHPID" 2>/dev/null | tr -d ' ')
  if [[ -z "$own_pgid" || "$pgid" == "$own_pgid" ||
        "$pgid" != "$pid" || "$session" != "$pid" ||
        "$process_ppid" != "$BASHPID" ]]; then
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" 0 0 || true
    exec {token_fd}<&-
    RUNNER_LAUNCH_ACTIVE_TASK=""
    RUNNER_LAUNCH_ACTIVE_PID=""
    RUNNER_LAUNCH_STATE=idle
    _runner_launch_restore_signal_traps \
      "$saved_term_trap" "$saved_int_trap"
    _runner_launch_close_telemetry_fds_v2
    echo "runner launcher refused unisolated process identity pid=$pid pgid=$pgid session=$session" >&2
    return 76
  fi
  _runner_launch_fault_v2 after_held_identity || {
    rc=$?
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" 0 0 || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" ""
    return "$rc"
  }

  runner_trusted_identity_publish \
    "$task" "$stage" "$run_id" "$epoch" "$runner_id" \
    "$pid" "$pgid" "$session" "$starttime" || {
      rc=$?
      _runner_launch_pre_release_abort_v2 \
        "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
        "$pid" "$pgid" "$session" "$starttime" 0 0 || true
      exec {token_fd}<&-
      RUNNER_LAUNCH_ACTIVE_TASK=""
      RUNNER_LAUNCH_ACTIVE_PID=""
      RUNNER_LAUNCH_STATE=idle
      _runner_launch_restore_signal_traps \
        "$saved_term_trap" "$saved_int_trap"
      _runner_launch_close_telemetry_fds_v2
      return "$rc"
    }
  RUNNER_LAUNCH_ACTIVE_PUBLISHED=1
  RUNNER_LAUNCH_STATE=published
  _runner_launch_fault_v2 after_identity_publish || {
    rc=$?
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" 0 0 || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" ""
    return "$rc"
  }

  browser_transport_start || {
    rc=$?
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" 0 0 || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" ""
    return "$rc"
  }

  debug_log_init "${FACTORY_RUN_PROFILE:-}" "$task" "$stage" "$run_dir" "$run_id" "$epoch" \
    || true
  debug_log_event decisions route_resolved \
    route_source "${FACTORY_DEBUG_ROUTE_SOURCE:-unknown}" \
    primary "${FACTORY_DEBUG_PRIMARY:-$runner_id}" \
    failover "${FACTORY_DEBUG_FAILOVER:-}" \
    runner "$runner_id" model "$model" \
    family "${FACTORY_DEBUG_FAMILY:-unknown}" \
    catalog_revision "${FACTORY_DEBUG_CATALOG_REVISION:-unknown}" \
    plan_level "${FACTORY_DEBUG_PLAN_LEVEL:-unknown}" \
    reason "${FACTORY_DEBUG_REASON:-primary}" || true
  debug_log_event verbose process_started runner "$runner_id" pid "$pid" pgid "$pgid" \
    stage "$stage" || true

  IFS=$'\t' read -r started_at started_ns clock_boot < <(runtime_analytics_now_v2) || {
    rc=$?
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" 0 0 || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" ""
    return "$rc"
  }
  if (( analytics_enabled )); then
    export FACTORY_LIFECYCLE_RUN_ID=$run_id FACTORY_LIFECYCLE_EPOCH=$epoch
    export FACTORY_LIFECYCLE_SPAN_ID
    FACTORY_LIFECYCLE_SPAN_ID=$(runtime_analytics_id_v2 sp \
      "$FACTORY_LIFECYCLE_ATTEMPT_ID" "$FACTORY_LIFECYCLE_DISPATCH_ID" \
      "$run_id" "$epoch" runner) || {
        rc=$?
        _runner_launch_pre_release_abort_v2 \
          "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
          "$pid" "$pgid" "$session" "$starttime" "$started_ns" 0 || true
        _runner_launch_held_cleanup_v2 \
          "$token_fd" "$saved_term_trap" "$saved_int_trap" ""
        return "$rc"
      }
  fi
  event_output=$(mktemp "$control_root/.runner-started.XXXXXX") || {
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" "$started_ns" 0 || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" ""
    return 1
  }
  FACTORY_LIFECYCLE_EVENT_AT=$started_at \
  FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$started_ns \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$clock_boot \
    _runner_lifecycle_started_v2 \
      "$runner_id" "$run_id" "$epoch" "$model" "$effort" "$family" \
      "$pid" "$pgid" "$session" "$starttime" "$provider_mode" \
      "$requested_scope" "$parent_ref" "$RUNNER_LINEAGE_RESERVATION" \
      "$lineage_generation" >"$event_output"
  rc=$?
  if (( rc == 0 )); then
    IFS= read -r runner_started_hash <"$event_output" || rc=78
  fi
  rm -f -- "$event_output"
  if (( rc != 0 )) || [[ ! "$runner_started_hash" =~ ^[a-f0-9]{64}$ ]]; then
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" "$started_ns" 1 || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" ""
    return 78
  fi
  RUNNER_LAUNCH_LAST_STARTED=1
  _runner_launch_fault_v2 after_runner_started || {
    rc=$?
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" "$started_ns" 1 || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" ""
    return "$rc"
  }

  context_file=$(mktemp "$control_root/.runtime-usage-context.XXXXXX") || {
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" "$started_ns" 1 || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" ""
    return 1
  }
  _runner_runtime_context_write "$context_file" \
    "$runner_id" "$task" "$stage" "$run_id" "$epoch" "$model" "$effort" \
    "$run_dir" "$run_dir_dev" "$run_dir_ino" "$events_dev" "$events_ino" \
    "$pid" "$pgid" "$session" "$starttime" "$started_at" "$started_at" 0 unknown false \
    "$runner_started_hash" "$provider_mode" "$requested_scope" "$parent_ref" \
    "$lineage_generation" "$normalizer_parent" "$status_mode" "$usage_dir" "$dialect" "$model" || rc=$?
  if (( ${rc:-0} == 0 )); then
    _runner_runtime_usage_call meta-initial "$context_file" >/dev/null || rc=$?
  fi
  if (( ${rc:-0} == 0 )); then
    _runner_lineage_mark_started_v2 "$runner_id" "$run_id" "$runner_started_hash" || rc=$?
  fi
  if (( ${rc:-0} != 0 )); then
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" "$started_ns" 1 || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" "$context_file"
    return "$rc"
  fi
  _runner_launch_fault_v2 after_lineage_started || {
    rc=$?
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" "$started_ns" 1 || true
    _runner_launch_held_cleanup_v2 \
      "$token_fd" "$saved_term_trap" "$saved_int_trap" "$context_file"
    return "$rc"
  }
  _runner_launch_restore_signal_traps \
    "$saved_term_trap" "$saved_int_trap"

  if ! kill -CONT "$pid" 2>/dev/null; then
    _runner_launch_pre_release_abort_v2 \
      "$runner_id" "$task" "$stage" "$run_id" "$epoch" \
      "$pid" "$pgid" "$session" "$starttime" "$started_ns" 1 || true
    exec {token_fd}<&-
    rm -f -- "$context_file"
    RUNNER_LAUNCH_ACTIVE_TASK="" RUNNER_LAUNCH_ACTIVE_PID="" RUNNER_LAUNCH_STATE=idle
    _runner_launch_close_telemetry_fds_v2
    return 76
  fi
  RUNNER_LAUNCH_STATE=running
  if [[ "$status_mode" == request ]]; then
    # В request-режиме progress должен попадать в реестр, пока model process ещё жив:
    # иначе внутренние узлы схемы за весь длинный run оставались бы «не начаты».
    while kill -0 "$pid" 2>/dev/null; do
      status_request_consume_all "$task" "$stage" "$run_id" "$epoch" "$status_token" "$request_dir"
      consume_rc=$?
      if [[ "$consume_rc" -ne 0 ]]; then
        request_rc=$consume_rc
        break
      fi
      identity=$(_runner_process_full_identity "$pid" 2>/dev/null || true)
      if [[ -n "$identity" ]]; then
        read -r pgid session starttime process_state process_ppid <<<"$identity"
      else
        process_state=""
      fi
      [[ -z "$process_state" || "$process_state" == Z ]] && break
      sleep 0.1
    done
    wait "$pid"; rc=$?
  else
    wait "$pid"; rc=$?
  fi

  # Забрать статус лидера сессии недостаточно: игнорирующий TERM потомок может сохранить
  # PGID и писать после начала восстановления базовой линии транзакции. Доверенный
  # запускатель владеет именно этими PGID/session и не снимает идентичность,
  # пока не исчезнет каждый участник.
  browser_transport_stop
  RUNNER_LAUNCH_STATE=quiescing
  if _runner_runtime_present "$pgid" "$session" "$starttime"; then
    _runner_quiesce_owned_runtime "$pid" "$pgid" "$session" "$starttime" 1 ||
      group_rc=$?
  fi
  if (( group_rc == 0 )); then
    IFS=$'\t' read -r quiesced_at quiesced_ns clock_boot < <(runtime_analytics_now_v2) || group_rc=78
  fi
  if (( group_rc == 0 )); then
    quiescence_evidence=$(runtime_analytics_hash_string_v2 \
      "quiesced:$runner_id:$task:$stage:$run_id:$epoch:$pid:$pgid:$session:$starttime:$quiesced_ns") || group_rc=$?
  fi
  if (( group_rc == 0 )); then
    runner_trusted_identity_clear \
      "$task" "$stage" "$run_id" "$epoch" "$runner_id" \
      "$pid" "$pgid" "$session" "$starttime" || group_rc=$?
  fi
  if (( group_rc != 0 )); then
    rc=76
  fi

  if [[ "$status_mode" == request ]]; then
    status_request_consume_all "$task" "$stage" "$run_id" "$epoch" "$status_token" "$request_dir"
    consume_rc=$?
    [[ "$request_rc" -ne 0 ]] || request_rc=$consume_rc
    rmdir "$request_dir" 2>/dev/null || true
    terminal_state=$(_run_state_get "$(run_state_active_file "$task" "$stage")" STATE)
    if [[ "$rc" -eq 0 && "$terminal_state" == committed ]]; then
      # Терминальный CAS уже принят: отдельный повреждённый progress-request не имеет
      # права задним числом превратить завершённый этап в provider failure.
      request_rc=0
    elif [[ "$request_rc" -ne 0 ]]; then
      rc=76
    elif [[ "$rc" -eq 0 && "$terminal_state" != committed ]]; then
      # Provider ответил успешно, но stage-result не был вызван: это ошибка протокола,
      # а не успешное выполнение этапа.
      rc=76
    fi
  fi
  exec {token_fd}<&-

  if (( group_rc != 0 )); then
    quiescence_evidence=$(runtime_analytics_hash_string_v2 \
      "quiescence-unproven:$runner_id:$task:$stage:$run_id:$epoch:$pid:$pgid:$session:$starttime") || \
      quiescence_evidence=$(printf unproven | sha256sum | awk '{print $1}')
    _runner_lineage_block_v2 "$runner_id" "$run_id" checkpoint_ineligible \
      "$quiescence_evidence" || true
    rm -f -- "$context_file"
    RUNNER_LAUNCH_ACTIVE_TASK=""
    RUNNER_LAUNCH_ACTIVE_PID=""
    RUNNER_LAUNCH_ACTIVE_PGID=""
    RUNNER_LAUNCH_ACTIVE_SESSION=""
    RUNNER_LAUNCH_ACTIVE_STARTTIME=""
    RUNNER_LAUNCH_ACTIVE_PUBLISHED=0
    RUNNER_LAUNCH_STATE=idle
    _runner_launch_close_telemetry_fds_v2
    return 76
  fi

  RUNNER_LAUNCH_ACTIVE_TASK=""
  RUNNER_LAUNCH_ACTIVE_PID=""
  RUNNER_LAUNCH_ACTIVE_PGID=""
  RUNNER_LAUNCH_ACTIVE_SESSION=""
  RUNNER_LAUNCH_ACTIVE_STARTTIME=""
  RUNNER_LAUNCH_ACTIVE_PUBLISHED=0
  RUNNER_LAUNCH_STATE=idle
  result_class=$(runner_call "$runner_id" classify "$run_dir" "$rc" 2>/dev/null || printf unknown)
  _runner_runtime_result_class_valid "$result_class" || result_class=unknown
  RUNNER_POSTAMBLE_RESULT_CLASS=$result_class
  if declare -F _multi_postamble_reclassify_v2 >/dev/null; then
    _multi_postamble_reclassify_v2 \
      "$task" "$stage" "$run_id" "$epoch" "$result_class" || {
        RUNNER_POSTAMBLE_RESULT_CLASS=unknown
      }
  fi
  if _runner_runtime_result_class_valid "${RUNNER_POSTAMBLE_RESULT_CLASS:-}"; then
    result_class=$RUNNER_POSTAMBLE_RESULT_CLASS
  else
    result_class=unknown
  fi
  case "$rc" in
    124|130|143) process_complete=false ;;
    *) process_complete=true ;;
  esac

  # Финализация источника идёт через дескрипторы и заканчивается до дописывания
  # runner_finished. Ни adapter, ни postamble не переоткрывают доступный провайдеру events.jsonl.
  _runner_runtime_context_write "$context_file" \
    "$runner_id" "$task" "$stage" "$run_id" "$epoch" "$model" "$effort" \
    "$run_dir" "$run_dir_dev" "$run_dir_ino" "$events_dev" "$events_ino" \
    "$pid" "$pgid" "$session" "$starttime" "$started_at" "$quiesced_at" "$rc" \
    "$result_class" "$process_complete" "$runner_started_hash" "$provider_mode" \
    "$requested_scope" "$parent_ref" "$lineage_generation" "$normalizer_parent" \
    "$status_mode" "$usage_dir" "$dialect" "$model" || source_rc=$?
  prepared_file=$(mktemp "$control_root/.runtime-usage-prepared.XXXXXX") || source_rc=1
  if (( source_rc == 0 )); then
    _runner_runtime_usage_call prepare "$context_file" >"$prepared_file" || source_rc=$?
  fi
  if (( source_rc == 0 && analytics_enabled == 1 )); then
    replacement_file=$(mktemp "$control_root/.runtime-usage-replacement.XXXXXX") || source_rc=1
    if (( source_rc == 0 )); then
      _runner_lineage_scope_guard_v2 "$runner_id" "$prepared_file" "$replacement_file" || source_rc=$?
    fi
    if (( source_rc == 0 )) && [[ -s "$replacement_file" ]]; then
      rm -f -- "$prepared_file"
      prepared_file=$replacement_file
      replacement_file=""
    fi
    [[ -z "$replacement_file" ]] || rm -f -- "$replacement_file"
  fi
  if (( source_rc == 0 )); then
    observed_scope=$(runtime_analytics_json_get_v2 "$prepared_file" observedProviderScope 2>/dev/null || true)
    [[ "$observed_scope" != null ]] || observed_scope=""
    source_evidence=$(runtime_analytics_json_get_v2 "$prepared_file" sourceFingerprint.sha256 2>/dev/null || true)
  fi

  if (( analytics_enabled )); then
    event_output=$(mktemp "$control_root/.runner-scope.XXXXXX") || lifecycle_rc=1
    if (( lifecycle_rc == 0 )); then
      _runner_lifecycle_scope_bound_v2 "$runner_id" "$observed_scope" "$requested_scope" \
        "$source_evidence" >"$event_output" || lifecycle_rc=$?
    fi
    if (( lifecycle_rc == 0 )); then
      IFS= read -r scope_event_hash <"$event_output" || lifecycle_rc=78
      [[ "$scope_event_hash" =~ ^[a-f0-9]{64}$ ]] || lifecycle_rc=78
    fi
    rm -f -- "$event_output"
  else
    scope_event_hash=$(runtime_analytics_hash_string_v2 \
      "standalone-scope:$runner_id:$run_id:$epoch") || lifecycle_rc=$?
  fi

  event_output=$(mktemp "$control_root/.runner-finished.XXXXXX") || lifecycle_rc=1
  if (( lifecycle_rc == 0 )); then
    FACTORY_LIFECYCLE_EVENT_AT=$quiesced_at \
    FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$quiesced_ns \
    FACTORY_LIFECYCLE_EVENT_BOOT_ID=$clock_boot \
      _runner_lifecycle_finished_v2 "$result_class" "$rc" "$started_ns" "$quiesced_ns" \
        "$quiesced_at" "$quiescence_evidence" >"$event_output" || lifecycle_rc=$?
  fi
  if (( lifecycle_rc == 0 && analytics_enabled == 1 )); then
    IFS= read -r finished_event_hash <"$event_output" || lifecycle_rc=78
    [[ "$finished_event_hash" =~ ^[a-f0-9]{64}$ ]] || lifecycle_rc=78
  fi
  rm -f -- "$event_output"

  if (( source_rc == 0 && lifecycle_rc == 0 && analytics_enabled == 1 )); then
    publication_file=$(mktemp "$control_root/.runtime-usage-publication.XXXXXX") || analytics_rc=1
    if (( analytics_rc == 0 )); then
      _runner_runtime_usage_call publish "$context_file" "$prepared_file" >"$publication_file" || analytics_rc=$?
    fi
    (( analytics_rc != 0 )) || publication_ready=1
    if (( analytics_rc == 0 )); then
      event_output=$(mktemp "$control_root/.runner-usage.XXXXXX") || analytics_rc=1
    fi
    if (( analytics_rc == 0 )); then
      _runner_lifecycle_usage_v2 "$publication_file" >"$event_output" || analytics_rc=$?
    fi
    if (( analytics_rc == 0 )); then
      IFS= read -r usage_event_hash <"$event_output" || analytics_rc=78
      [[ "$usage_event_hash" =~ ^[a-f0-9]{64}$ ]] || analytics_rc=78
    fi
    rm -f -- "$event_output"
  fi

  # Writable-финализатор проверяет полный каталог usage после обычной двойной записи
  # document/event. Если публикация прошла, но дописывание события сорвалось, reconciler
  # чинит точный разрыв после падения и возвращает долговечный хеш события, нужный для
  # продвижения provider-lineage.
  if (( analytics_enabled == 1 && lifecycle_rc == 0 )); then
    runtime_lifecycle_reconcile_usage_v2 \
      "$task" "$FACTORY_LIFECYCLE_ATTEMPT_ID" "$run_id" >/dev/null
    reconcile_rc=$?
    if (( reconcile_rc != 0 )); then
      (( analytics_rc != 0 )) || analytics_rc=$reconcile_rc
    elif (( publication_ready == 1 && analytics_rc != 0 )) &&
         [[ "$RUNTIME_LIFECYCLE_USAGE_RECONCILED_HASH" =~ ^[a-f0-9]{64}$ ]]; then
      usage_event_hash=$RUNTIME_LIFECYCLE_USAGE_RECONCILED_HASH
      analytics_rc=0
    fi
  fi
  if (( publication_ready == 1 && analytics_rc == 0 )); then
    _runner_lineage_commit_usage_v2 "$runner_id" "$run_id" "$publication_file" \
      "$usage_event_hash" "$scope_event_hash" || analytics_rc=$?
  fi
  if (( analytics_rc != 0 )) && [[ "$RUNNER_LINEAGE_STARTED" == 1 ]]; then
    _runner_lineage_block_v2 "$runner_id" "$run_id" usage_document_conflict \
      "$runner_started_hash" || true
  elif (( publication_ready == 0 )) && [[ "$RUNNER_LINEAGE_STARTED" == 1 ]]; then
    _runner_lineage_block_v2 "$runner_id" "$run_id" missing_complete_usage \
      "$runner_started_hash" || true
  fi

  if [[ "$result_class" != ok ]]; then
    debug_log_event errors runner_error runner "$runner_id" result "$result_class" rc "$rc" \
      phase started || true
  fi
  debug_log_event decisions runner_result runner "$runner_id" result "$result_class" rc "$rc" \
    started 1 || true
  # Диагностическое зеркало — последняя двойная запись; оно атомарно заменяется из
  # host-фактов. Созданный провайдером symlink/FIFO никогда не открывается.
  _runner_runtime_context_write "$context_file" \
    "$runner_id" "$task" "$stage" "$run_id" "$epoch" "$model" "$effort" \
    "$run_dir" "$run_dir_dev" "$run_dir_ino" "$events_dev" "$events_ino" \
    "$pid" "$pgid" "$session" "$starttime" "$started_at" "$quiesced_at" "$rc" \
    "$result_class" "$process_complete" "$runner_started_hash" "$provider_mode" \
    "$requested_scope" "$parent_ref" "$lineage_generation" "$normalizer_parent" \
    "$status_mode" "$usage_dir" "$dialect" "$model" || meta_rc=$?
  if (( meta_rc == 0 )) && [[ -s "$prepared_file" ]]; then
    _runner_runtime_usage_call meta-final "$context_file" "$prepared_file" "$result_class" \
      >/dev/null || meta_rc=$?
  elif (( meta_rc == 0 )); then
    _runner_runtime_usage_call meta-final "$context_file" - "$result_class" \
      >/dev/null || meta_rc=$?
  fi
  rm -f -- "$context_file" "$prepared_file" "$publication_file" "$replacement_file"
  _runner_launch_close_telemetry_fds_v2
  (( source_rc == 0 && lifecycle_rc == 0 && analytics_rc == 0 && meta_rc == 0 )) || return 76
  return "$rc"
}
