#!/usr/bin/env bash

# Функции используют локальные поля runner_launch. Секрет очередной операции
# удерживает Bash, который владеет control pipe. В argv helper идут только пути.

# До fork оставляем запись, которую увидит новый сервер даже без .pipeline.
# Состояние после сбоя записи трактуется как неизвестное владение.
_runner_darwin_intent_prepare() {
  local task=$1 stage=$2 run_id=$3 epoch=$4 file
  _runner_trusted_identity_prepare || return
  file=$(runner_trusted_identity_file "$task") || return
  runner_intent_file="$file.pending"
  printf -v runner_intent_record 'TASK=%s\nSTAGE=%s\nRUN_ID=%s\nEPOCH=%s\n' "$task" "$stage" "$run_id" "$epoch"
  (
    umask 077
    set -C
    printf '%s' "$runner_intent_record" >"$runner_intent_file"
  ) || return 78
  runner_intent_owned=1
  "$FACTORY_DARWIN_PROCESS_HELPER" sync-runner-fd 3 3<"$runner_intent_file" &&
    "$FACTORY_DARWIN_PROCESS_HELPER" sync-runner-fd 3 3<"$(dirname -- "$runner_intent_file")"
}

# Снимать pending можно после durable active либо доказанного отсутствия spawn.
# Сбой удаления оставляет запись для точного host recovery.
_runner_darwin_intent_clear() {
  (( runner_intent_owned == 1 )) || return 0
  # $(<file) срезает завершающий перевод строки, а эталон хранит его — нормализуем эталон.
  [[ -f "$runner_intent_file" && ! -L "$runner_intent_file" &&
     "$(<"$runner_intent_file")" == "${runner_intent_record%$'\n'}" ]] || return 78
  rm -- "$runner_intent_file" || return
  "$FACTORY_DARWIN_PROCESS_HELPER" sync-runner-fd 3 3<"$(dirname -- "$runner_intent_file")" || return
  runner_intent_owned=0
}

runner_darwin_intent_absent() {
  local file dir
  file=$(runner_trusted_identity_file "$1") || return
  dir=$(dirname -- "$file") || return
  [[ -d "$dir" && ! -L "$dir" && "$(realpath -e -- "$dir")" == "$dir" &&
     ! -e "$file.pending" && ! -L "$file.pending" ]]
}

# Scope связывает те же 11 строк identity с launch UUID и загрузкой.
# До синхронизации scope launcher не выдаёт SIGCONT своему runner.
_runner_darwin_scope_publish() {
  local task=$1 file boot actual launch_file digest temp sid
  local launch_id=${FACTORY_DARWIN_LAUNCH_ID:-}
  boot=${FACTORY_DARWIN_LAUNCH_BOOT_ID:-}
  [[ -n "$launch_id$boot" ]] || return 0
  [[ "$launch_id" =~ ^[a-f0-9-]{36}$ && "$boot" =~ ^[a-f0-9-]{36}$ ]] || return 78
  actual=$("$FACTORY_DARWIN_PROCESS_HELPER" boot-id) || return 78
  [[ "${actual,,}" == "$boot" ]] || return 78
  launch_file="$(factory_control_root)/launch-processes/t${task}.${launch_id}.json"
  [[ -f "$launch_file" && ! -L "$launch_file" ]] || return 78
  sid=$(_runner_own_session) || return 78
  jq -e --arg id "$launch_id" --arg boot "$boot" --arg task "$task" --argjson sid "$sid" '
    .format == 1 and .task == $task and .launchId == $id and
    .bootId == $boot and .phase == "registered" and .process.sid == $sid
  ' "$launch_file" >/dev/null || return 78
  file=$(runner_trusted_identity_file "$task") || return
  digest=$(runtime_analytics_hash_file_v2 "$file") || return
  temp=$(mktemp "$(dirname -- "$file")/.scope.XXXXXX") || return
  if ! jq -cn --arg task "$task" --arg boot "$boot" --arg launch "$launch_id" --arg digest "$digest" \
    '{format:1, task:$task, bootId:$boot, launchId:$launch, bindingSHA256:$digest}' >"$temp" ||
    ! runtime_analytics_durable_replace_v2 "$temp" "$file.scope"; then
    rm -f -- "$temp"
    return 78
  fi
}

# Старая scope запись не может закрыть новую попытку с другим active hash.
_runner_darwin_scope_clear() {
  local file=$1 digest
  [[ -e "$file.scope" || -L "$file.scope" ]] || return 0
  [[ -f "$file.scope" && ! -L "$file.scope" ]] || return 78
  digest=$(runtime_analytics_hash_file_v2 "$file") || return
  jq -e --arg digest "$digest" '.format == 1 and .bindingSHA256 == $digest' \
    "$file.scope" >/dev/null || return 78
  runtime_analytics_durable_unlink_v2 "$file.scope"
}

_runner_darwin_fd_prepare() {
  local task=$1 run_id=$2 epoch=$3 marker ready_task ready_run ready_epoch ready_dev ready_ino extra
  local helper=${FACTORY_DARWIN_PROCESS_HELPER:-}
  [[ "$helper" == /* && -f "$helper" && -x "$helper" && ! -L "$helper" ]] || return 78
  read -r run_dir_dev run_dir_ino < <(/usr/bin/stat -f '%d %i' "$run_dir") || return 78
  [[ "$run_dir_dev:$run_dir_ino" =~ ^[0-9]+:[0-9]+$ ]] || return 78
  exec {run_dir_fd}<"$run_dir" || return 78
  broker_dir=$(mktemp -d "$control_root/.fd.XXXXXX") || return 78

  # Дескрипторы самого coproc остаются close-on-exec. Их не дублируем в общие
  # FD launcher, чтобы долгоживущий клиент профиля не удерживал control pipe.
  coproc GRIGDESK_RUNNER_FD_BROKER {
    exec "$helper" runner-fd-hold "$broker_dir" "$run_dir" "$task" "$run_id" "$epoch" \
      "$run_dir_dev" "$run_dir_ino" 3<&"$run_dir_fd"
  }
  broker_pid=${GRIGDESK_RUNNER_FD_BROKER_PID:-}
  broker_read=${GRIGDESK_RUNNER_FD_BROKER[0]:-}
  broker_write=${GRIGDESK_RUNNER_FD_BROKER[1]:-}
  [[ -n "$broker_pid" && -n "$broker_read" && -n "$broker_write" ]] || return 78
  IFS=' ' read -r -t 5 -u "$broker_read" marker ready_task ready_run ready_epoch \
    ready_dev ready_ino events_dev events_ino extra || return 78
  [[ "$marker" == READY && "$ready_task" == "$task" && "$ready_run" == "$run_id" &&
     "$ready_epoch" == "$epoch" && "$ready_dev:$ready_ino" == "$run_dir_dev:$run_dir_ino" &&
     "$events_dev:$events_ino" =~ ^[0-9]+:[0-9]+$ && -z "$extra" ]]
}

_runner_darwin_fd_close() {
  if [[ "${broker_write:-}" =~ ^[0-9]+$ && "$broker_write" == "${GRIGDESK_RUNNER_FD_BROKER[1]:-}" ]]; then
    exec {broker_write}>&- 2>/dev/null || true
    broker_write=
  fi
  if [[ "${broker_read:-}" =~ ^[0-9]+$ && "$broker_read" == "${GRIGDESK_RUNNER_FD_BROKER[0]:-}" ]]; then
    exec {broker_read}<&- 2>/dev/null || true
    broker_read=
  fi
  if [[ "${run_dir_fd:-}" =~ ^[0-9]+$ ]]; then
    exec {run_dir_fd}<&- 2>/dev/null || true
    run_dir_fd=
  fi
  if [[ "${broker_pid:-}" =~ ^[0-9]+$ ]]; then
    # EOF прерывает ожидание сессии. Действующий сетевой read ограничен в helper.
    wait "$broker_pid" 2>/dev/null || true
    broker_pid=
  fi
  if [[ -n "${broker_dir:-}" ]]; then
    rmdir -- "$broker_dir" 2>/dev/null || true
    broker_dir=
  fi
}

_runner_darwin_fd_grant() {
  local operation=$1 pipe_trap marker extra rc=78 trace=0
  [[ "${broker_read:-}" =~ ^[0-9]+$ && "${broker_write:-}" =~ ^[0-9]+$ ]] || return 78
  if [[ "$-" == *x* ]]; then
    trace=1
    set +x
  fi
  # Сбой держателя возвращает статус операции. SIGPIPE чужого конца не убивает Bash.
  pipe_trap=$(trap -p PIPE)
  trap '' PIPE
  if { printf '%s' "$operation" >&"$broker_write"; } 2>/dev/null &&
     IFS=' ' read -r -t 5 -u "$broker_read" marker fd_nonce extra &&
     [[ "$marker" == PERMIT && "$fd_nonce" =~ ^[0-9a-f]{64}$ && -z "$extra" ]]; then
    rc=0
  fi
  if [[ -n "$pipe_trap" ]]; then
    eval "$pipe_trap"
  else
    trap - PIPE
  fi
  (( rc == 0 )) || fd_nonce=
  (( trace == 0 )) || set -x
  return "$rc"
}

_runner_darwin_usage_exec() {
  local operation=$1 fd_nonce= rc=78 trace=0
  export -n fd_nonce
  shift
  if [[ "$-" == *x* ]]; then
    trace=1
    set +x
  fi
  if _runner_darwin_fd_grant "$operation"; then
    rc=0
    "$FACTORY_DARWIN_PROCESS_HELPER" runner-fd-exec "$broker_dir" "$operation" "$@" \
      4< <(printf '%s' "$fd_nonce") || rc=$?
  fi
  fd_nonce=
  (( trace == 0 )) || set -x
  return "$rc"
}
