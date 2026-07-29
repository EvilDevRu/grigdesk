#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"
source "$FACTORY_HOME/lib/debug-log.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/status-request.sh"

_runner_process_identity() {
  local pid=${1:?pid} stat pgid starttime
  stat=$(cat "/proc/$pid/stat" 2>/dev/null) || return 1
  pgid=$(awk '{print $5}' <<<"$stat")
  starttime=$(awk '{print $22}' <<<"$stat")
  [[ "$pgid" =~ ^[0-9]+$ && "$starttime" =~ ^[0-9]+$ ]] || return 1
  printf '%s %s\n' "$pgid" "$starttime"
}

runner_process_matches() {
  local pid=${1:?pid} expected_pgid=${2:?pgid} expected_starttime=${3:?starttime}
  local identity pgid starttime
  identity=$(_runner_process_identity "$pid") || return 1
  read -r pgid starttime <<<"$identity"
  [[ "$pgid" == "$expected_pgid" && "$starttime" == "$expected_starttime" ]]
}

runner_launch() {
  local runner_id=$1 task=$2 prompt=$3 stage=$4 model=$5 effort=$6 timeout_s=$7
  local run_dir=$8 run_id=$9 epoch=${10} status_token=${11}
  local module control_root token_file token_fd pid identity pgid starttime rc result_class own_pgid
  local capabilities status_mode=status_fd request_dir="" request_rc=0 consume_rc=0
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
  control_root="${FACTORY_CONTROL_ROOT:-$config_root/control}"
  mkdir -p "$control_root/tokens"
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
  FACTORY_LAUNCH_BARRIER=1 \
  FACTORY_RUN_TASK="$task" FACTORY_RUN_STAGE="$stage" \
  FACTORY_RUN_ID="$run_id" FACTORY_RUN_EPOCH="$epoch" \
  FACTORY_STATUS_MODE="$status_mode" FACTORY_STATUS_REQUEST_DIR="$request_dir" \
  setsid bash "$FACTORY_HOME/lib/runner-bridge.sh" "$module" "$runner_id" run \
    "$task" "$prompt" "$stage" "$model" "$effort" "$timeout_s" "$run_dir" \
    7<&"$token_fd" >>"$run_dir/events.jsonl" 2>"$run_dir/stderr.log" &
  pid=$!

  identity=""
  local poll process_state=""
  for poll in {1..100}; do
    identity=$(_runner_process_identity "$pid") || identity=""
    process_state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true)
    [[ -n "$identity" && "$process_state" == T ]] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.01
  done
  if [[ -z "$identity" || "$process_state" != T ]]; then
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid"; rc=$?
    exec {token_fd}<&-
    return "$rc"
  fi
  read -r pgid starttime <<<"$identity"
  own_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  if [[ -z "$own_pgid" || "$pgid" == "$own_pgid" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    exec {token_fd}<&-
    echo "runner launcher refused shared PGID $pgid" >&2
    return 76
  fi

  {
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
    printf 'CLI_VERSION=%s\n' "${FACTORY_RUNNER_VERSION:-unknown}"
    printf 'SOURCE=runtime\n'
    printf 'STATUS_MODE=%s\n' "$status_mode"
  } >"$run_dir/meta.env"
  chmod 600 "$run_dir/meta.env" 2>/dev/null || true

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
    reason primary || true
  debug_log_event verbose process_started runner "$runner_id" pid "$pid" pgid "$pgid" \
    stage "$stage" || true

  kill -CONT "$pid" 2>/dev/null || true
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
      process_state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true)
      [[ -z "$process_state" || "$process_state" == Z ]] && break
      sleep 0.1
    done
    wait "$pid"; rc=$?
    status_request_consume_all "$task" "$stage" "$run_id" "$epoch" "$status_token" "$request_dir"
    consume_rc=$?
    [[ "$request_rc" -ne 0 ]] || request_rc=$consume_rc
    rmdir "$request_dir" 2>/dev/null || true
    if [[ "$request_rc" -ne 0 ]]; then
      rc=76
    elif [[ "$rc" -eq 0 &&
            "$(_run_state_get "$(run_state_active_file "$task" "$stage")" STATE)" != committed ]]; then
      # Provider ответил успешно, но stage-result не был вызван: это ошибка протокола,
      # а не успешное выполнение этапа.
      rc=76
    fi
  else
    wait "$pid"; rc=$?
  fi
  exec {token_fd}<&-
  result_class=$(runner_call "$runner_id" classify "$run_dir" "$rc" 2>/dev/null || printf unknown)
  printf 'RESULT_CLASS=%s\nRC=%s\n' "$result_class" "$rc" >>"$run_dir/meta.env"
  if [[ "$result_class" != ok ]]; then
    debug_log_event errors runner_error runner "$runner_id" result "$result_class" rc "$rc" \
      phase started || true
  fi
  debug_log_event decisions runner_result runner "$runner_id" result "$result_class" rc "$rc" \
    started 1 || true
  return "$rc"
}
