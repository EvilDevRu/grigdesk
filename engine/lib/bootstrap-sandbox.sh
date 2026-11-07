#!/usr/bin/env bash

V2_BOOTSTRAP_UP_PID=""
V2_BOOTSTRAP_UP_STARTTIME=""
V2_BOOTSTRAP_WORKSPACE_DIR=""
V2_BOOTSTRAP_WORKSPACE_ENV=""
V2_BOOTSTRAP_WORKSPACE_HASH=""
V2_SANDBOX_SPAN_OPEN=0
V2_SANDBOX_SPAN_WORKSPACE=""

# Один span охватывает весь подъём, включая работу сервисов одновременно с разведкой.
# Его открывает и закрывает родитель: дочерний up.sh не получает lifecycle authority.
v2_sandbox_span_begin() {
  local policy_hash
  V2_SANDBOX_SPAN_WORKSPACE=$(runtime_analytics_hash_string_v2 \
    "$V2_WORKSPACE_MODE|$PROFILE|t$TASK|$V2_ATTEMPT|$V2_SANDBOX_ENV|${V2_REPO_WORKTREES[*]}") || return 78
  policy_hash=$(runtime_analytics_hash_string_v2 \
    "$V2_ATTEMPT_CATALOG_HASH|${ROUTE_V2_ROUTE_HASH:-}|$V2_WORKSPACE_MODE|sandbox-v2") || return 78
  runtime_lifecycle_sandbox_begin_v2 \
    "$V2_WORKSPACE_MODE" "$V2_SANDBOX_SPAN_WORKSPACE" "$policy_hash" >/dev/null || return
  V2_SANDBOX_SPAN_OPEN=1
}

# Ошибка подготовки сохраняется, даже если запись завершающего события тоже отказала.
# Повторное закрытие не добавляет второй sandbox_finished в журнал попытки.
v2_sandbox_span_finish() {
  local rc=$1 status=${2:-succeeded} reason=${3:-normal} evidence finish_rc=0
  [[ "$V2_SANDBOX_SPAN_OPEN" == 1 ]] || return "$rc"
  if (( rc != 0 )) && [[ "$status" == succeeded ]]; then
    status=failed
    reason=unavailable
  fi
  evidence=$(runtime_analytics_hash_string_v2 "sandbox:$V2_ATTEMPT:$V2_WORKSPACE_MODE:rc=$rc") || evidence=""
  runtime_lifecycle_sandbox_finish_v2 \
    "$V2_SANDBOX_SPAN_WORKSPACE" "$status" "$reason" "$evidence" >/dev/null || finish_rc=$?
  V2_SANDBOX_SPAN_OPEN=0
  (( rc == 0 )) || return "$rc"
  return "$finish_rc"
}

# Временная передача workspace принадлежит только этому процессу запуска и лежит
# в control root. Реестр готовой песочницы остаётся на прежнем месте.
v2_bootstrap_workspace_cleanup() {
  [[ -n "$V2_BOOTSTRAP_WORKSPACE_DIR" ]] || return 0
  rm -f -- "$V2_BOOTSTRAP_WORKSPACE_ENV"
  rmdir -- "$V2_BOOTSTRAP_WORKSPACE_DIR" 2>/dev/null || true
  V2_BOOTSTRAP_WORKSPACE_DIR=""
  V2_BOOTSTRAP_WORKSPACE_ENV=""
  V2_BOOTSTRAP_WORKSPACE_HASH=""
}

# Scout не разрешает вход в основной маршрут: сначала нужен успешный exit up.sh,
# health и те же самые метаданные workspace, на которых прошла разведка.
v2_sandbox_bootstrap_wait() {
  local rc=0 actual_hash
  [[ -n "$V2_BOOTSTRAP_UP_PID" ]] || return 0
  wait "$V2_BOOTSTRAP_UP_PID" || rc=$?
  if [[ -n "$V2_BOOTSTRAP_UP_STARTTIME" ]]; then
    _runner_quiesce_owned_runtime \
      "$V2_BOOTSTRAP_UP_PID" "$V2_BOOTSTRAP_UP_PID" "$V2_BOOTSTRAP_UP_PID" \
      "$V2_BOOTSTRAP_UP_STARTTIME" "${FACTORY_TERM_GRACE_SECONDS:-5}" || return 73
  fi
  V2_BOOTSTRAP_UP_PID=""
  V2_BOOTSTRAP_UP_STARTTIME=""
  if (( rc == 0 )); then
    v2_read_sandbox || rc=$?
  fi
  if (( rc == 0 )) && [[ -n "$V2_BOOTSTRAP_WORKSPACE_HASH" ]]; then
    actual_hash=$(runtime_analytics_hash_file_v2 "$V2_SANDBOX_ENV") || rc=78
    if [[ "$actual_hash" != "$V2_BOOTSTRAP_WORKSPACE_HASH" ]]; then
      v2_log "метаданные песочницы изменились после начала разведки"
      rc=75
    fi
  fi
  v2_bootstrap_workspace_cleanup
  v2_sandbox_span_finish "$rc"
}

# Остановка оркестратора завершает принадлежащую ему сессию up.sh целиком.
# Частично созданные БД и рабочие деревья сохраняются для штатного разбора человеком.
v2_sandbox_bootstrap_cancel() {
  local rc=0
  if [[ -n "$V2_BOOTSTRAP_UP_PID" ]]; then
    if [[ -n "$V2_BOOTSTRAP_UP_STARTTIME" ]]; then
      _runner_quiesce_owned_runtime \
        "$V2_BOOTSTRAP_UP_PID" "$V2_BOOTSTRAP_UP_PID" "$V2_BOOTSTRAP_UP_PID" \
        "$V2_BOOTSTRAP_UP_STARTTIME" "${FACTORY_TERM_GRACE_SECONDS:-5}" || rc=$?
    else
      # До снятия launch barrier up.sh ещё не исполнялся и не мог создать потомков.
      kill -KILL "$V2_BOOTSTRAP_UP_PID" 2>/dev/null || true
    fi
    (( rc == 0 )) || return "$rc"
    wait "$V2_BOOTSTRAP_UP_PID" 2>/dev/null || true
    V2_BOOTSTRAP_UP_PID=""
    V2_BOOTSTRAP_UP_STARTTIME=""
  fi
  v2_bootstrap_workspace_cleanup
  v2_sandbox_span_finish 143 interrupted signal || rc=$?
  (( rc == 143 )) && return 0
  return "$rc"
}

# Старый профиль просто завершает up.sh, и сохраняется последовательный запуск.
# Новый может атомарно передать готовый workspace раньше: до конца up.sh разрешён
# только bootstrap, который читает исходники, пока профиль готовит данные и сервисы.
v2_sandbox_bootstrap_prepare() {
  local state identity pgid session starttime process_state ppid poll
  state=$(v2_sandbox_state) || return
  if [[ "$V2_WORKSPACE_MODE" != isolated || "$MODE" != start || "$state" != absent ]]; then
    v2_sandbox_up_lifecycle
    return
  fi
  V2_BOOTSTRAP_WORKSPACE_DIR=$(mktemp -d "$(v2_attempt_artifacts)/.sandbox-bootstrap.XXXXXX") || return 1
  V2_BOOTSTRAP_WORKSPACE_ENV="$V2_BOOTSTRAP_WORKSPACE_DIR/workspace.env"
  v2_sandbox_span_begin || return

  STATE_DIR="$STATE_DIR" \
    FACTORY_WORKSPACE_MODE=isolated \
    FACTORY_REQUIRE_NEW_SANDBOX=1 \
    FACTORY_BE_BASE_REF="$BE_BASE_REF" \
    FACTORY_FE_BASE_REF="$FE_BASE_REF" \
    FACTORY_BOOTSTRAP_WORKSPACE_ENV="$V2_BOOTSTRAP_WORKSPACE_ENV" \
    setsid bash -c 'kill -STOP "$$"; exec bash "$@"' -- \
      "$FACTORY_PROFILES_DIR/$PROFILE/up.sh" "$TASK" \
    >>"$LOGDIR/t${TASK}.orch.log" 2>&1 &
  V2_BOOTSTRAP_UP_PID=$!

  # До фиксации identity ребёнок стоит на барьере: даже сигнал в этом окне не
  # оставит работающий up.sh без известной родителю границы остановки.
  for poll in {1..100}; do
    identity=$(_runner_process_full_identity "$V2_BOOTSTRAP_UP_PID" 2>/dev/null || true)
    [[ -n "$identity" ]] || break
    read -r pgid session starttime process_state ppid <<<"$identity"
    if [[ "$pgid" == "$V2_BOOTSTRAP_UP_PID" && "$session" == "$V2_BOOTSTRAP_UP_PID" &&
          "$process_state" == T ]]; then
      V2_BOOTSTRAP_UP_STARTTIME=$starttime
      break
    fi
    sleep 0.01
  done
  if [[ -z "$V2_BOOTSTRAP_UP_STARTTIME" ]] && kill -0 "$V2_BOOTSTRAP_UP_PID" 2>/dev/null; then
    return 73
  fi
  if [[ -n "$V2_BOOTSTRAP_UP_STARTTIME" ]]; then
    kill -CONT "$V2_BOOTSTRAP_UP_PID" || return 73
  fi

  while kill -0 "$V2_BOOTSTRAP_UP_PID" 2>/dev/null; do
    if [[ -e "$V2_BOOTSTRAP_WORKSPACE_ENV" || -L "$V2_BOOTSTRAP_WORKSPACE_ENV" ]]; then
      [[ -f "$V2_BOOTSTRAP_WORKSPACE_ENV" && ! -L "$V2_BOOTSTRAP_WORKSPACE_ENV" ]] || return 78
      v2_read_sandbox workspace "$V2_BOOTSTRAP_WORKSPACE_ENV" || return
      V2_BOOTSTRAP_WORKSPACE_HASH=$(runtime_analytics_hash_file_v2 "$V2_BOOTSTRAP_WORKSPACE_ENV") || return 78
      v2_log "рабочие деревья готовы; разведка идёт параллельно подготовке стенда"
      return 0
    fi
    sleep 0.1
  done
  v2_sandbox_bootstrap_wait
}
