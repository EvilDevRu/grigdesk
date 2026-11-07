#!/usr/bin/env bash
# Короткие операции отдельной разведки используют проверенные attempt/pins.
# Журнал и ответ не открывают основной cursor, runner или provisioning lifecycle.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/attempt-stage-state.sh"

# Все операции журнала берут один task lock и повторно сверяют активную identity.
# Чтение terminal разрешено; запись в закрытую или чужую попытку запрещена.
attempt_bootstrap_journal_v2() {
  local operation=$1 task=$2 attempt=$3 profile=$4 lock_fd rc
  shift 4
  task=$(_attempt_state_task_id "$task") || return
  attempt=$(_attempt_state_attempt_id "$attempt") || return
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" '' \
    "$([[ "$operation" == read ]] && printf 1 || printf 0)"
  rc=$?
  if (( rc == 0 )) && [[ "$ASTAGE_PROFILE" != "$profile" ||
       "$ASTAGE_ROUTES_DIR" != "${ROUTES_DIR:-$ASTAGE_ROUTES_DIR}" ]]; then
    rc=75
  fi
  if (( rc == 0 )); then
    python3 "$FACTORY_HOME/lib/bootstrap_journal.py" "$operation" "$ASTAGE_ATTEMPT_DIR" \
      "$task" "$attempt" "$ASTAGE_PROFILE" "$ASTAGE_CATALOG_HASH" \
      "$ASTAGE_ROUTE" "$ASTAGE_ROUTE_HASH" "$ASTAGE_ROUTES_DIR" "$@"
    rc=$?
  fi
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}

# Ответ должен конфликтовать с любым живым оркестратором до CAS журнала.
# Это тот же отдельный control lock, которым пользуется factory, а не pipeline orch.lock.
attempt_bootstrap_answer_v2() {
  local task=$1 attempt=$2 profile=$3 visit=$4 stop_hash=$5 answer=$6 directory answer_lock rc
  task=$(_attempt_state_task_id "$task") || return
  [[ "$visit" =~ ^b_[a-f0-9]{32}$ && "$stop_hash" =~ ^[a-f0-9]{64}$ ]] || return 75
  directory="$(factory_control_root)/protocol-v2/orchestrators"
  mkdir -p -- "$directory" || return 1
  [[ -d "$directory" && ! -L "$directory" ]] || return 78
  exec {answer_lock}>"$directory/t${task}.lock" || return 1
  if ! flock -n "$answer_lock"; then
    eval "exec ${answer_lock}>&-"
    return 73
  fi
  attempt_bootstrap_journal_v2 answer "$task" "$attempt" "$profile" "$visit" "$stop_hash" "$answer"
  rc=$?
  eval "exec ${answer_lock}>&-"
  return "$rc"
}
