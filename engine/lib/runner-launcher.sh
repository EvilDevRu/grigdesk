#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"
source "$FACTORY_HOME/lib/debug-log.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/status-request.sh"

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

_runner_launch_record_usage() {
  # Расход токенов завершённого хода. Метод `usage` опционален: у kimi ACP-мост
  # не публикует расход вовсе, и прочерк там честнее выдуманного нуля.
  #
  # Значения проверяются здесь, а не доверяются раннеру: meta.env читают и awk
  # движка, и кокпит, поэтому одна строка произвольного вида из чужого CLI
  # испортила бы диагностику всей попытки.
  local runner_id=$1 run_dir=$2 line value
  declare -F "runner_${runner_id}_usage" >/dev/null 2>&1 || return 0
  while IFS= read -r line; do
    value=${line#*=}
    case "$line" in
      TOKENS_IN=*|TOKENS_OUT=*|TOKENS_CACHE_READ=*|TOKENS_CACHE_WRITE=*)
        [[ "$value" =~ ^[0-9]+$ ]] || continue ;;
      COST_USD=*)
        [[ "$value" =~ ^[0-9]+(\.[0-9]+)?$ ]] || continue ;;
      *) continue ;;
    esac
    printf '%s\n' "$line" >>"$run_dir/meta.env"
  done < <(runner_call "$runner_id" usage "$run_dir" 2>/dev/null || true)
  return 0
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

runner_launch() {
  local runner_id=$1 task=$2 prompt=$3 stage=$4 model=$5 effort=$6 timeout_s=$7
  local run_dir=$8 run_id=$9 epoch=${10} status_token=${11}
  local module control_root token_file token_fd pid identity pgid session starttime process_ppid
  local rc result_class own_pgid group_rc=0
  local saved_term_trap="" saved_int_trap=""
  local capabilities status_mode=status_fd request_dir="" request_rc=0 consume_rc=0
  local terminal_state=""
  module=$(runner_module_path "$runner_id") || return 2
  runner_contract_check "$runner_id" || return 2
  mkdir -p "$run_dir"
  : >"$run_dir/events.jsonl"
  : >"$run_dir/stderr.log"
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
  control_root=$(factory_control_root) || return 78
  mkdir -p "$control_root/tokens"
  [[ ! -L "$control_root" && "$(realpath -e -- "$control_root" 2>/dev/null)" == "$control_root" ]] ||
    return 78
  chmod 700 "$control_root" "$control_root/tokens" 2>/dev/null || true
  token_file=$(mktemp "$control_root/tokens/.capability.XXXXXX")
  chmod 600 "$token_file"
  printf '%s\n' "$status_token" >"$token_file"
  exec {token_fd}<"$token_file"
  rm -f -- "$token_file"

  factory_exec_check local setsid || {
    exec {token_fd}<&-
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
  FACTORY_LAUNCH_BARRIER=1 \
  FACTORY_RUN_TASK="$task" FACTORY_RUN_STAGE="$stage" \
  FACTORY_RUN_ID="$run_id" FACTORY_RUN_EPOCH="$epoch" \
  FACTORY_STATUS_MODE="$status_mode" FACTORY_STATUS_REQUEST_DIR="$request_dir" \
  setsid bash "$FACTORY_HOME/lib/runner-bridge.sh" "$module" "$runner_id" run \
    "$task" "$prompt" "$stage" "$model" "$effort" "$timeout_s" "$run_dir" \
    7<&"$token_fd" >>"$run_dir/events.jsonl" 2>"$run_dir/stderr.log" &
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
    exec {token_fd}<&-
    RUNNER_LAUNCH_ACTIVE_TASK=""
    RUNNER_LAUNCH_ACTIVE_PID=""
    RUNNER_LAUNCH_STATE=idle
    _runner_launch_restore_signal_traps \
      "$saved_term_trap" "$saved_int_trap"
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
    _runner_terminate_barrier_child "$pid"
    exec {token_fd}<&-
    RUNNER_LAUNCH_ACTIVE_TASK=""
    RUNNER_LAUNCH_ACTIVE_PID=""
    RUNNER_LAUNCH_STATE=idle
    _runner_launch_restore_signal_traps \
      "$saved_term_trap" "$saved_int_trap"
    echo "runner launcher refused unisolated process identity pid=$pid pgid=$pgid session=$session" >&2
    return 76
  fi

  if ! {
    printf 'SCHEMA=1\n'
    printf 'RUNNER=%s\n' "$runner_id"
    printf 'TASK=%s\n' "$task"
    printf 'STAGE=%s\n' "$stage"
    printf 'RUN_ID=%s\n' "$run_id"
    printf 'EPOCH=%s\n' "$epoch"
    printf 'PID=%s\n' "$pid"
    printf 'PGID=%s\n' "$pgid"
    printf 'STARTTIME=%s\n' "$starttime"
    printf 'MODEL=%s\n' "$model"
    printf 'EFFORT=%s\n' "$effort"
    printf 'ROUTE_REASON=%s\n' "${FACTORY_DEBUG_REASON:-primary}"
    printf 'CLI_VERSION=%s\n' "${FACTORY_RUNNER_VERSION:-unknown}"
    printf 'SOURCE=runtime\n'
    printf 'STATUS_MODE=%s\n' "$status_mode"
  } >"$run_dir/meta.env"; then
    _runner_terminate_barrier_child "$pid"
    exec {token_fd}<&-
    RUNNER_LAUNCH_ACTIVE_TASK=""
    RUNNER_LAUNCH_ACTIVE_PID=""
    RUNNER_LAUNCH_STATE=idle
    _runner_launch_restore_signal_traps \
      "$saved_term_trap" "$saved_int_trap"
    return 1
  fi
  chmod 600 "$run_dir/meta.env" 2>/dev/null || true
  runner_trusted_identity_publish \
    "$task" "$stage" "$run_id" "$epoch" "$runner_id" \
    "$pid" "$pgid" "$session" "$starttime" || {
      rc=$?
      _runner_terminate_barrier_child "$pid"
      runner_trusted_identity_clear \
        "$task" "$stage" "$run_id" "$epoch" "$runner_id" \
        "$pid" "$pgid" "$session" "$starttime" 2>/dev/null || true
      exec {token_fd}<&-
      RUNNER_LAUNCH_ACTIVE_TASK=""
      RUNNER_LAUNCH_ACTIVE_PID=""
      RUNNER_LAUNCH_STATE=idle
      _runner_launch_restore_signal_traps \
        "$saved_term_trap" "$saved_int_trap"
      return "$rc"
    }
  RUNNER_LAUNCH_ACTIVE_PUBLISHED=1
  RUNNER_LAUNCH_STATE=published
  _runner_launch_restore_signal_traps \
    "$saved_term_trap" "$saved_int_trap"

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

  kill -CONT "$pid" 2>/dev/null || true
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
  RUNNER_LAUNCH_STATE=quiescing
  if _runner_runtime_present "$pgid" "$session" "$starttime"; then
    _runner_quiesce_owned_runtime "$pid" "$pgid" "$session" "$starttime" 1 ||
      group_rc=$?
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
  RUNNER_LAUNCH_ACTIVE_TASK=""
  RUNNER_LAUNCH_ACTIVE_PID=""
  RUNNER_LAUNCH_ACTIVE_PGID=""
  RUNNER_LAUNCH_ACTIVE_SESSION=""
  RUNNER_LAUNCH_ACTIVE_STARTTIME=""
  RUNNER_LAUNCH_ACTIVE_PUBLISHED=0
  RUNNER_LAUNCH_STATE=idle
  result_class=$(runner_call "$runner_id" classify "$run_dir" "$rc" 2>/dev/null || printf unknown)
  printf 'RESULT_CLASS=%s\nRC=%s\n' "$result_class" "$rc" >>"$run_dir/meta.env"
  _runner_launch_record_usage "$runner_id" "$run_dir"
  if [[ "$result_class" != ok ]]; then
    debug_log_event errors runner_error runner "$runner_id" result "$result_class" rc "$rc" \
      phase started || true
  fi
  debug_log_event decisions runner_result runner "$runner_id" result "$result_class" rc "$rc" \
    started 1 || true
  return "$rc"
}
