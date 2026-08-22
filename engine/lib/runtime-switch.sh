#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/run-state.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

_runtime_switch_file() {
  local task=${1#[tT]} stage=$2 root
  root=$(factory_control_root)
  printf '%s/requests/t%s/%s.switch\n' "$root" "$task" "$stage"
}

_runtime_switch_pending_record() {
  local run_id=$1 epoch=$2 target=$3 request_id=$4
  printf 'SCHEMA=1\nREQUEST_ID=%s\nRUN_ID=%s\nEPOCH=%s\nTARGET=%s\nSTATE=pending\n' \
    "$request_id" "$run_id" "$epoch" "$target"
}

_runtime_switch_pending_hash() {
  _runtime_switch_pending_record "$@" | sha256sum | awk '{print $1}'
}

_runtime_switch_durable_replace() {
  runtime_analytics_durable_replace_v2 "$1" "$2"
}

_runtime_switch_durable_unlink() {
  runtime_analytics_durable_unlink_v2 "$1"
}

# У legacy/non-route запуска нет активной неизменяемой попытки и, следовательно, нет
# lifecycle-журнала для дописывания. Но при активной попытке точная идентичность раннера
# обязательна: молчаливый пропуск телеметрии switch разъединил бы историю control-plane
# и авторизованное ею действие.
_runtime_switch_lifecycle_prepare() {
  local task=$1 run_id=$2 epoch=$3 rc
  RUNTIME_SWITCH_LIFECYCLE=0
  runtime_lifecycle_active_attempt_v2 "$task" >/dev/null 2>&1
  rc=$?
  if (( rc == 3 )); then
    return 0
  fi
  (( rc == 0 )) || return "$rc"
  runtime_lifecycle_bind_run_v2 "$task" "$run_id" "$epoch" || return
  RUNTIME_SWITCH_LIFECYCLE=1
}

_runtime_switch_emit_rejected() {
  local task=$1 run_id=$2 epoch=$3 request_id=$4 target=$5 record_hash=$6
  local reason=$7 evidence=${8:-} rc
  [[ "$epoch" =~ ^[1-9][0-9]*$ && "$target" =~ ^[a-z][a-z0-9_-]*$ &&
     "$record_hash" =~ ^[a-f0-9]{64}$ ]] || return 0
  _runtime_switch_lifecycle_prepare "$task" "$run_id" "$epoch"
  rc=$?
  (( rc == 0 && RUNTIME_SWITCH_LIFECYCLE == 1 )) || return 0
  runtime_lifecycle_switch_event_v2 runner_switch_rejected \
    "$request_id" "$run_id" "$epoch" "$target" "$record_hash" \
    "$evidence" "$reason" >/dev/null || true
}

runtime_switch_request() {
  local task=$1 stage=$2 expected_run=$3 expected_epoch=$4 target=$5 request_id=$6
  [[ "$target" =~ ^[a-z][a-z0-9_-]*$ && "$request_id" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  local lock_fd active request active_run active_epoch state tmp rc record_hash evidence
  local backup="" had_previous=0
  record_hash=$(_runtime_switch_pending_hash \
    "$expected_run" "$expected_epoch" "$target" "$request_id") || return
  pipeline_lock_acquire "$task" lock_fd || return
  active=$(run_state_active_file "$task" "$stage") || {
    pipeline_lock_release "$lock_fd"; return 2;
  }
  active_run=$(_run_state_get "$active" RUN_ID)
  active_epoch=$(_run_state_get "$active" EPOCH)
  state=$(_run_state_get "$active" STATE)
  if [[ "$active_run" != "$expected_run" || "$active_epoch" != "$expected_epoch" || "$state" != active ]]; then
    evidence=$(runtime_analytics_hash_file_v2 "$active" 2>/dev/null || true)
    if [[ "$active_epoch" != "$expected_epoch" ]]; then
      _runtime_switch_emit_rejected "$task" "$expected_run" "$expected_epoch" \
        "$request_id" "$target" "$record_hash" stale_epoch "$evidence"
    else
      _runtime_switch_emit_rejected "$task" "$expected_run" "$expected_epoch" \
        "$request_id" "$target" "$record_hash" run_not_active "$evidence"
    fi
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  request=$(_runtime_switch_file "$task" "$stage")
  if [[ -f "$request" && "$(_run_state_get "$request" STATE)" == pending ]]; then
    evidence=$(runtime_analytics_hash_file_v2 "$request" 2>/dev/null || true)
    _runtime_switch_emit_rejected "$task" "$expected_run" "$expected_epoch" \
      "$request_id" "$target" "$record_hash" duplicate "$evidence"
    pipeline_lock_release "$lock_fd"
    return 76
  fi
  mkdir -p "$(dirname "$request")"
  [[ -d "$(dirname "$request")" && ! -L "$(dirname "$request")" ]] || {
    pipeline_lock_release "$lock_fd"
    return 78
  }
  if [[ -e "$request" || -L "$request" ]]; then
    [[ -f "$request" && ! -L "$request" ]] || {
      pipeline_lock_release "$lock_fd"
      return 78
    }
    backup=$(mktemp "$(dirname "$request")/.switch-backup.XXXXXX") || {
      pipeline_lock_release "$lock_fd"
      return 1
    }
    cp -- "$request" "$backup" && chmod 600 "$backup" || {
      rc=$?
      rm -f -- "$backup"
      pipeline_lock_release "$lock_fd"
      return "$rc"
    }
    had_previous=1
  fi
  _runtime_switch_lifecycle_prepare "$task" "$expected_run" "$expected_epoch" || {
    rc=$?
    rm -f -- "$backup"
    pipeline_lock_release "$lock_fd"
    return "$rc"
  }
  tmp=$(mktemp "$(dirname "$request")/.switch.XXXXXX") || {
    rm -f -- "$backup"
    pipeline_lock_release "$lock_fd"
    return 1
  }
  _runtime_switch_pending_record \
    "$expected_run" "$expected_epoch" "$target" "$request_id" >"$tmp" &&
    chmod 600 "$tmp" && _runtime_switch_durable_replace "$tmp" "$request" || {
      rc=$?
      rm -f -- "$tmp" "$backup"
      pipeline_lock_release "$lock_fd"
      return "$rc"
    }
  if (( RUNTIME_SWITCH_LIFECYCLE == 1 )); then
    runtime_lifecycle_switch_event_v2 runner_switch_requested \
      "$request_id" "$expected_run" "$expected_epoch" "$target" "$record_hash" \
      >/dev/null || {
        rc=$?
        if (( had_previous )); then
          _runtime_switch_durable_replace "$backup" "$request" || rc=1
          backup=""
        else
          _runtime_switch_durable_unlink "$request" || rc=1
        fi
        rm -f -- "$backup"
        pipeline_lock_release "$lock_fd"
        return "$rc"
      }
  fi
  rm -f -- "$backup"
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
  local lock_fd request active run_id epoch stored_request state target tmp backup
  local record_hash evidence rc active_run active_epoch active_state
  pipeline_lock_acquire "$task" lock_fd || return
  active=$(run_state_active_file "$task" "$stage") || {
    pipeline_lock_release "$lock_fd"; return 2;
  }
  request=$(_runtime_switch_file "$task" "$stage")
  [[ -f "$request" ]] || {
    pipeline_lock_release "$lock_fd"; return 73;
  }
  run_id=$(_run_state_get "$request" RUN_ID)
  epoch=$(_run_state_get "$request" EPOCH)
  stored_request=$(_run_state_get "$request" REQUEST_ID)
  state=$(_run_state_get "$request" STATE)
  target=$(_run_state_get "$request" TARGET)
  record_hash=$(_run_state_get "$request" REQUEST_RECORD_SHA256)
  [[ "$record_hash" =~ ^[a-f0-9]{64}$ ]] ||
    record_hash=$(runtime_analytics_hash_file_v2 "$request") || {
      pipeline_lock_release "$lock_fd"
      return 78
    }
  active_run=$(_run_state_get "$active" RUN_ID)
  active_epoch=$(_run_state_get "$active" EPOCH)
  active_state=$(_run_state_get "$active" STATE)
  if [[ "$active_run" != "$expected_run" || "$active_epoch" != "$expected_epoch" ||
        "$active_state" != active ]]; then
    evidence=$(runtime_analytics_hash_file_v2 "$active" 2>/dev/null || true)
    if [[ "$active_epoch" != "$expected_epoch" ]]; then
      _runtime_switch_emit_rejected "$task" "$run_id" "$epoch" "$stored_request" \
        "$target" "$record_hash" stale_epoch "$evidence"
    else
      _runtime_switch_emit_rejected "$task" "$run_id" "$epoch" "$stored_request" \
        "$target" "$record_hash" run_not_active "$evidence"
    fi
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  if [[ "$run_id" != "$expected_run" || "$epoch" != "$expected_epoch" || \
        "$stored_request" != "$request_id" ]]; then
    evidence=$(runtime_analytics_hash_file_v2 "$request" 2>/dev/null || true)
    _runtime_switch_emit_rejected "$task" "$run_id" "$epoch" "$stored_request" \
      "$target" "$record_hash" integrity_conflict "$evidence"
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  if [[ "$state" != pending ]]; then
    evidence=$(runtime_analytics_hash_file_v2 "$request" 2>/dev/null || true)
    _runtime_switch_emit_rejected "$task" "$run_id" "$epoch" "$stored_request" \
      "$target" "$record_hash" duplicate "$evidence"
    pipeline_lock_release "$lock_fd"
    return 75
  fi
  [[ "$target" =~ ^[a-z][a-z0-9_-]*$ ]] || {
    pipeline_lock_release "$lock_fd"
    return 78
  }
  _runtime_switch_lifecycle_prepare "$task" "$run_id" "$epoch" || {
    rc=$?
    pipeline_lock_release "$lock_fd"
    return "$rc"
  }
  backup=$(mktemp "$(dirname "$request")/.switch-backup.XXXXXX") || {
    pipeline_lock_release "$lock_fd"
    return 1
  }
  tmp=$(mktemp "$(dirname "$request")/.switch.XXXXXX") || {
    rm -f -- "$backup"
    pipeline_lock_release "$lock_fd"
    return 1
  }
  cp -- "$request" "$backup" && chmod 600 "$backup" &&
    awk -v record_hash="$record_hash" '
      /^STATE=/ { print "STATE=consumed"; state_seen=1; next }
      /^REQUEST_RECORD_SHA256=/ { next }
      { print }
      END {
        if (!state_seen) exit 1
        print "REQUEST_RECORD_SHA256=" record_hash
      }
    ' "$request" >"$tmp" && chmod 600 "$tmp" || {
      rc=$?
      rm -f -- "$tmp" "$backup"
      pipeline_lock_release "$lock_fd"
      return "$rc"
    }
  evidence=$(runtime_analytics_hash_file_v2 "$tmp") || {
    rc=$?
    rm -f -- "$tmp" "$backup"
    pipeline_lock_release "$lock_fd"
    return "$rc"
  }
  _runtime_switch_durable_replace "$tmp" "$request" || {
    rc=$?
    rm -f -- "$tmp" "$backup"
    pipeline_lock_release "$lock_fd"
    return "$rc"
  }
  if (( RUNTIME_SWITCH_LIFECYCLE == 1 )); then
    runtime_lifecycle_switch_event_v2 runner_switch_consumed \
      "$stored_request" "$run_id" "$epoch" "$target" "$record_hash" \
      "$evidence" >/dev/null || {
        rc=$?
        _runtime_switch_durable_replace "$backup" "$request" || rc=1
        backup=""
        rm -f -- "$backup"
        pipeline_lock_release "$lock_fd"
        return "$rc"
      }
  fi
  rm -f -- "$backup"
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
