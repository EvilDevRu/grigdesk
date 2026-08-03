#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/run-state.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

_runtime_switch_file() {
  local task=${1#[tT]} stage=$2 root
  root=$(factory_control_root)
  printf '%s/requests/t%s/%s.switch\n' "$root" "$task" "$stage"
}

runtime_switch_request() {
  local task=$1 stage=$2 expected_run=$3 expected_epoch=$4 target=$5 request_id=$6
  [[ "$target" =~ ^[a-z][a-z0-9_-]*$ && "$request_id" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  local lock_fd active request active_run active_epoch state tmp rc
  pipeline_lock_acquire "$task" lock_fd || return
  active=$(run_state_active_file "$task" "$stage") || {
    pipeline_lock_release "$lock_fd"; return 2;
  }
  active_run=$(_run_state_get "$active" RUN_ID)
  active_epoch=$(_run_state_get "$active" EPOCH)
  state=$(_run_state_get "$active" STATE)
  if [[ "$active_run" != "$expected_run" || "$active_epoch" != "$expected_epoch" || "$state" != active ]]; then
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  request=$(_runtime_switch_file "$task" "$stage")
  if [[ -f "$request" && "$(_run_state_get "$request" STATE)" == pending ]]; then
    pipeline_lock_release "$lock_fd"
    return 76
  fi
  mkdir -p "$(dirname "$request")"
  tmp=$(mktemp "$(dirname "$request")/.switch.XXXXXX")
  {
    printf 'SCHEMA=1\nREQUEST_ID=%s\nRUN_ID=%s\nEPOCH=%s\nTARGET=%s\nSTATE=pending\n' \
      "$request_id" "$expected_run" "$expected_epoch" "$target"
  } >"$tmp"
  mv -f -- "$tmp" "$request"
  pipeline_store_update_unlocked "$task" "RUNNER_OVERRIDE_STAGE_${stage}" "$target"
  rc=$?
  pipeline_lock_release "$lock_fd"
  return "$rc"
}

runtime_signal_active() {
  local pid=$1 pgid=$2 starttime=$3 session=${4:-$1}
  [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ && "$starttime" =~ ^[0-9]+$ &&
     "$session" =~ ^[0-9]+$ ]] || return 2
  local own_pgid
  own_pgid=$(ps -o pgid= -p "$BASHPID" 2>/dev/null | tr -d ' ')
  [[ -n "$own_pgid" && "$pgid" != "$own_pgid" ]] || return 73
  runner_process_matches "$pid" "$pgid" "$starttime" || return 73
  # Сигнал идёт всей сессии раннера, а не одной группе лидера: у провайдера
  # под GNU timeout собственная группа, и TERM в группу лидера его не достанет.
  _runner_signal_runtime TERM "$pgid" "$session"
}

runtime_switch_consume() {
  local task=$1 stage=$2 expected_run=$3 expected_epoch=$4 request_id=$5
  local lock_fd request active run_id epoch stored_request state target tmp
  pipeline_lock_acquire "$task" lock_fd || return
  active=$(run_state_active_file "$task" "$stage") || {
    pipeline_lock_release "$lock_fd"; return 2;
  }
  if [[ "$(_run_state_get "$active" RUN_ID)" != "$expected_run" ||
        "$(_run_state_get "$active" EPOCH)" != "$expected_epoch" ||
        "$(_run_state_get "$active" STATE)" != active ]]; then
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  request=$(_runtime_switch_file "$task" "$stage")
  [[ -f "$request" ]] || {
    pipeline_lock_release "$lock_fd"; return 73;
  }
  run_id=$(_run_state_get "$request" RUN_ID)
  epoch=$(_run_state_get "$request" EPOCH)
  stored_request=$(_run_state_get "$request" REQUEST_ID)
  state=$(_run_state_get "$request" STATE)
  target=$(_run_state_get "$request" TARGET)
  if [[ "$run_id" != "$expected_run" || "$epoch" != "$expected_epoch" || \
        "$stored_request" != "$request_id" ]]; then
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  if [[ "$state" != pending ]]; then
    pipeline_lock_release "$lock_fd"
    return 75
  fi
  tmp=$(mktemp "$(dirname "$request")/.switch.XXXXXX")
  sed 's/^STATE=.*/STATE=consumed/' "$request" >"$tmp"
  mv -f -- "$tmp" "$request"
  pipeline_lock_release "$lock_fd"
  printf '%s\n' "$target"
}

runtime_interrupt_and_wait() {
  local pid=$1 pgid=$2 starttime=$3 grace_s=${4:-5} expected_session=${5:-$1}
  [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ &&
     "$starttime" =~ ^[0-9]+$ && "$expected_session" =~ ^[0-9]+$ &&
     "$grace_s" =~ ^[0-9]+$ ]] || return 2
  local own_pgid
  own_pgid=$(ps -o pgid= -p "$BASHPID" 2>/dev/null | tr -d ' ')
  [[ -n "$own_pgid" && "$pgid" != "$own_pgid" ]] || return 73
  if ! runner_process_full_matches \
    "$pid" "$pgid" "$expected_session" "$starttime"; then
    # Лидер мог завершиться между доверенным чтением и отправкой сигнала.
    # Такая гонка безопасна, только если точные PGID/session уже пусты.
    runner_runtime_absent "$pgid" "$expected_session" "$starttime" && return 0
    return 73
  fi
  _runner_quiesce_owned_runtime \
    "$pid" "$pgid" "$expected_session" "$starttime" "$grace_s"
}

runtime_interrupt_trusted_active() {
  local task=$1 expected_stage=${2:-} expected_run=${3:-} expected_epoch=${4:-}
  local grace_s=${5:-5} identity rc
  local stage run_id epoch runner pid pgid session starttime
  identity=$(runner_trusted_identity_read \
    "$task" "$expected_stage" "$expected_run" "$expected_epoch")
  rc=$?
  (( rc == 0 )) || return "$rc"
  read -r stage run_id epoch runner pid pgid session starttime <<<"$identity"
  runtime_interrupt_and_wait "$pid" "$pgid" "$starttime" "$grace_s" "$session" ||
    return
  runner_trusted_identity_clear \
    "$task" "$stage" "$run_id" "$epoch" "$runner" \
    "$pid" "$pgid" "$session" "$starttime"
}
