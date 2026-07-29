#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/pipeline-store.sh"

factory_control_root() {
  if [[ -n "${FACTORY_CONTROL_ROOT:-}" ]]; then
    printf '%s\n' "$FACTORY_CONTROL_ROOT"
  elif [[ -n "${FACTORY_CONFIG_ROOT:-}" ]]; then
    printf '%s/control\n' "$FACTORY_CONFIG_ROOT"
  else
    printf '%s/.factory/control\n' "${HOME:?HOME or FACTORY_CONFIG_ROOT is required}"
  fi
}

factory_token_hash() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

factory_control_init() {
  local token=${1:?control token} root tmp
  root=$(factory_control_root)
  mkdir -p "$root"
  chmod 700 "$root" 2>/dev/null || true
  tmp=$(mktemp "$root/.control.XXXXXX")
  factory_token_hash "$token" >"$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$root/control.hash"
}

factory_control_verify() {
  local token=${1:-} root expected
  root=$(factory_control_root)
  expected=$(head -1 "$root/control.hash" 2>/dev/null | tr -d '[:space:]')
  [[ -n "$token" && -n "$expected" && "$(factory_token_hash "$token")" == "$expected" ]]
}

run_state_active_file() {
  local task=${1#[tT]} stage=${2:?stage} root
  [[ "$stage" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 2
  root=$(factory_control_root)
  printf '%s/runs/t%s/%s.active\n' "$root" "$task" "$stage"
}

_run_state_get() {
  local file=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null
}

_run_state_write() {
  local file=$1 run_id=$2 epoch=$3 token_hash=$4 state=$5 result=${6:-} comment=${7:-}
  local tmp
  mkdir -p "$(dirname "$file")"
  tmp=$(mktemp "$(dirname "$file")/.active.XXXXXX")
  {
    printf 'SCHEMA=1\nRUN_ID=%s\nEPOCH=%s\nTOKEN_HASH=%s\nSTATE=%s\n' \
      "$run_id" "$epoch" "$token_hash" "$state"
    [[ -z "$result" ]] || printf 'RESULT=%s\n' "$result"
    [[ -z "$comment" ]] || printf 'COMMENT=%s\n' "${comment//$'\n'/ }"
  } >"$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$file"
}

run_state_begin() {
  local task=$1 stage=$2 run_id=$3 epoch=$4 token=$5
  [[ "$run_id" =~ ^[A-Za-z0-9._-]+$ && "$epoch" =~ ^[0-9]+$ ]] || return 2
  local lock_fd file token_hash rc current_epoch
  pipeline_lock_acquire "$task" lock_fd || return
  file=$(run_state_active_file "$task" "$stage") || {
    pipeline_lock_release "$lock_fd"
    return 2
  }
  if [[ -f "$file" ]]; then
    current_epoch=$(_run_state_get "$file" EPOCH)
    if [[ "$current_epoch" =~ ^[0-9]+$ ]] && (( epoch <= current_epoch )); then
      pipeline_lock_release "$lock_fd"
      return 73
    fi
  fi
  token_hash=$(factory_token_hash "$token")
  _run_state_write "$file" "$run_id" "$epoch" "$token_hash" active
  pipeline_store_update_unlocked "$task" RUN_PROTOCOL 2 "$stage" running \
    "ACTIVE_RUN_${stage}" "$run_id" "ACTIVE_EPOCH_${stage}" "$epoch"
  rc=$?
  pipeline_lock_release "$lock_fd"
  return "$rc"
}

run_state_apply_result() {
  local task=$1 stage=$2 run_id=$3 epoch=$4 token=$5 result=$6 comment=${7:-}
  case "$result" in done|skipped|failed) ;; *) return 2 ;; esac
  local lock_fd file active_run active_epoch expected_hash state stored_result stored_comment rc
  pipeline_lock_acquire "$task" lock_fd || return
  file=$(run_state_active_file "$task" "$stage") || {
    pipeline_lock_release "$lock_fd"
    return 2
  }
  if [[ ! -f "$file" ]]; then
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  active_run=$(_run_state_get "$file" RUN_ID)
  active_epoch=$(_run_state_get "$file" EPOCH)
  expected_hash=$(_run_state_get "$file" TOKEN_HASH)
  state=$(_run_state_get "$file" STATE)
  if [[ "$active_run" != "$run_id" || "$active_epoch" != "$epoch" ]]; then
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  if [[ -z "$token" || "$(factory_token_hash "$token")" != "$expected_hash" ]]; then
    pipeline_lock_release "$lock_fd"
    return 74
  fi
  if [[ "$state" == committed ]]; then
    stored_result=$(_run_state_get "$file" RESULT)
    stored_comment=$(_run_state_get "$file" COMMENT)
    pipeline_store_update_unlocked "$task" "$stage" "$stored_result" \
      "${stage}_COMMENT" "$stored_comment" "ACTIVE_RUN_${stage}" ""
    pipeline_lock_release "$lock_fd"
    return 75
  fi
  [[ "$state" == active ]] || {
    pipeline_lock_release "$lock_fd"
    return 75
  }
  _run_state_write "$file" "$run_id" "$epoch" "$expected_hash" committed "$result" "$comment"
  pipeline_store_update_unlocked "$task" "$stage" "$result" "${stage}_COMMENT" "$comment" \
    "ACTIVE_RUN_${stage}" ""
  rc=$?
  pipeline_lock_release "$lock_fd"
  return "$rc"
}

run_state_validate_progress() {
  local stage=$1; shift
  (( $# >= 2 && $# % 2 == 0 )) || return 2
  local key value
  while (( $# >= 2 )); do
    key=$1; value=$2; shift 2
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && "$key" != "$stage" ]] || return 2
    case "$key" in
      ROUTE)
        [[ "$value" =~ ^[a-z][a-z0-9_-]*$ ]] || return 2 ;;
      ROUTE_BY)
        [[ "$value" =~ ^(scout|escalation)$ ]] || return 2 ;;
      SIZE)
        [[ "$value" =~ ^(S|M|L)$ ]] || return 2 ;;
      TRIVIAL_ESCALATED)
        [[ "$value" == 1 ]] || return 2 ;;
      PLANS|SKEPTIC|VALIDATE|TRANSLATOR)
        [[ "$value" =~ ^(running|done|skipped)$ ]] || return 2 ;;
      *)
        return 2 ;;
    esac
  done
}

run_state_apply_progress() {
  local task=$1 stage=$2 run_id=$3 epoch=$4 token=$5; shift 5
  run_state_validate_progress "$stage" "$@" || return
  local -a updates=("$@")

  local lock_fd file active_run active_epoch expected_hash state rc
  pipeline_lock_acquire "$task" lock_fd || return
  file=$(run_state_active_file "$task" "$stage") || {
    pipeline_lock_release "$lock_fd"
    return 2
  }
  [[ -f "$file" ]] || {
    pipeline_lock_release "$lock_fd"
    return 73
  }
  active_run=$(_run_state_get "$file" RUN_ID)
  active_epoch=$(_run_state_get "$file" EPOCH)
  expected_hash=$(_run_state_get "$file" TOKEN_HASH)
  state=$(_run_state_get "$file" STATE)
  if [[ "$active_run" != "$run_id" || "$active_epoch" != "$epoch" ]]; then
    pipeline_lock_release "$lock_fd"
    return 73
  fi
  if [[ -z "$token" || "$(factory_token_hash "$token")" != "$expected_hash" ]]; then
    pipeline_lock_release "$lock_fd"
    return 74
  fi
  [[ "$state" == active ]] || {
    pipeline_lock_release "$lock_fd"
    return 75
  }
  pipeline_store_update_unlocked "$task" "${updates[@]}"
  rc=$?
  pipeline_lock_release "$lock_fd"
  return "$rc"
}

run_state_control_update() {
  local task=$1; shift
  (( $# >= 2 && $# % 2 == 0 )) || return 2
  local stage=$1 result=$2 key value comment="" file=""
  local lock_fd run_id epoch token_hash rc
  case "$result" in
    done|skipped|failed)
      local -a pairs=("$@")
      local i
      for (( i=0; i<${#pairs[@]}; i+=2 )); do
        if [[ "${pairs[$i]}" == "${stage}_COMMENT" ]]; then
          comment=${pairs[$((i+1))]}
        fi
      done
      ;;
    *) stage="" ;;
  esac
  pipeline_lock_acquire "$task" lock_fd || return
  if [[ -n "$stage" ]]; then
    file=$(run_state_active_file "$task" "$stage" 2>/dev/null || true)
    if [[ -n "$file" && -f "$file" ]]; then
      run_id=$(_run_state_get "$file" RUN_ID)
      epoch=$(_run_state_get "$file" EPOCH)
      token_hash=$(_run_state_get "$file" TOKEN_HASH)
      _run_state_write "$file" "$run_id" "$epoch" "$token_hash" committed "$result" "$comment"
    fi
  fi
  pipeline_store_update_unlocked "$task" "$@"
  rc=$?
  pipeline_lock_release "$lock_fd"
  return "$rc"
}
