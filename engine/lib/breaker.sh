#!/usr/bin/env bash

_breaker_validate_id() {
  [[ "${1:-}" =~ ^[A-Za-z0-9._-]+$ ]]
}

_breaker_entry_id() {
  printf '%s|%s|%s' "$1" "$2" "$3" | sha256sum | awk '{print $1}'
}

_breaker_account_dir() {
  local provider=$1 fingerprint=$2
  printf '%s/runners/breakers/v1/%s/%s\n' "${STATE_DIR:?}" "$provider" "$fingerprint"
}

_breaker_entry_file() {
  local provider=$1 fingerprint=$2 scope=$3 family=$4 model=$5 dir id
  dir=$(_breaker_account_dir "$provider" "$fingerprint")
  id=$(_breaker_entry_id "$scope" "$family" "$model")
  printf '%s/%s.state\n' "$dir" "$id"
}

_breaker_get() {
  local file=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null
}

breaker_record() {
  local provider=$1 fingerprint=$2 scope=$3 family=$4 model=$5
  local detected_at=$6 limited_until=${7:-} evidence=${8:-}
  _breaker_validate_id "$provider" && _breaker_validate_id "$fingerprint" || return 2
  case "$scope" in
    provider) family=""; model="" ;;
    family) _breaker_validate_id "$family" || return 2; model="" ;;
    model) _breaker_validate_id "$family" && _breaker_validate_id "$model" || return 2 ;;
    *) return 2 ;;
  esac
  [[ "$detected_at" =~ ^[0-9]+$ ]] || return 2
  [[ -z "$limited_until" || "$limited_until" =~ ^[0-9]+$ ]] || return 2
  evidence=${evidence//$'\n'/ }
  local dir file lock_fd tmp
  dir=$(_breaker_account_dir "$provider" "$fingerprint")
  mkdir -p "$dir"
  exec {lock_fd}>"$dir/.lock"
  flock "$lock_fd" || return 1
  file=$(_breaker_entry_file "$provider" "$fingerprint" "$scope" "$family" "$model")
  tmp=$(mktemp "$dir/.breaker.XXXXXX")
  {
    printf 'SCHEMA=1\nSTATUS=limited\nSCOPE=%s\nFAMILY=%s\nMODEL=%s\n' \
      "$scope" "$family" "$model"
    printf 'DETECTED_AT=%s\nLIMITED_UNTIL=%s\nEVIDENCE=%s\n' \
      "$detected_at" "$limited_until" "$evidence"
  } >"$tmp"
  mv -f -- "$tmp" "$file"
  flock -u "$lock_fd"
  eval "exec ${lock_fd}>&-"
}

_breaker_entry_active() {
  local file=$1 now=$2 until status
  [[ -f "$file" ]] || return 1
  status=$(_breaker_get "$file" STATUS)
  until=$(_breaker_get "$file" LIMITED_UNTIL)
  [[ "$status" == limited ]] || return 1
  if [[ -n "$until" && "$until" != 0 && "$now" -gt "$until" ]]; then
    return 1
  fi
}

breaker_match() {
  local provider=$1 fingerprint=$2 family=$3 model=$4 now=$5
  local scope file
  BREAKER_MATCH_SCOPE=""
  BREAKER_MATCH_FILE=""
  for scope in provider family model; do
    case "$scope" in
      provider) file=$(_breaker_entry_file "$provider" "$fingerprint" provider "" "") ;;
      family) file=$(_breaker_entry_file "$provider" "$fingerprint" family "$family" "") ;;
      model) file=$(_breaker_entry_file "$provider" "$fingerprint" model "$family" "$model") ;;
    esac
    if _breaker_entry_active "$file" "$now"; then
      BREAKER_MATCH_SCOPE=$scope
      BREAKER_MATCH_FILE=$file
      return 0
    fi
  done
  return 1
}

breaker_clear() {
  local provider=$1 fingerprint=$2 scope=$3 family=$4 model=$5
  local dir file lock_fd
  dir=$(_breaker_account_dir "$provider" "$fingerprint")
  [[ -d "$dir" ]] || return 0
  exec {lock_fd}>"$dir/.lock"
  flock "$lock_fd" || return 1
  file=$(_breaker_entry_file "$provider" "$fingerprint" "$scope" "$family" "$model")
  rm -f -- "$file"
  flock -u "$lock_fd"
  eval "exec ${lock_fd}>&-"
}
