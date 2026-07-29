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
  local pid=$1 pgid=$2 starttime=$3
  [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ && "$starttime" =~ ^[0-9]+$ ]] || return 2
  local own_pgid
  own_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  [[ -n "$own_pgid" && "$pgid" != "$own_pgid" ]] || return 73
  runner_process_matches "$pid" "$pgid" "$starttime" || return 73
  kill -TERM -- "-$pgid" 2>/dev/null
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
  local pid=$1 pgid=$2 starttime=$3 grace_s=${4:-5}
  [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ && "$starttime" =~ ^[0-9]+$ ]] || return 2
  local own_pgid
  own_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  [[ -n "$own_pgid" && "$pgid" != "$own_pgid" ]] || return 73
  runner_process_matches "$pid" "$pgid" "$starttime" || return 73
  kill -TERM -- "-$pgid" 2>/dev/null || return 73
  local deadline=$((SECONDS + grace_s))
  while kill -0 "$pid" 2>/dev/null && (( SECONDS <= deadline )); do
    sleep 0.05
  done
  if kill -0 "$pid" 2>/dev/null; then
    runner_process_matches "$pid" "$pgid" "$starttime" || return 73
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
  kill -0 "$pid" 2>/dev/null && return 1
  return 0
}
