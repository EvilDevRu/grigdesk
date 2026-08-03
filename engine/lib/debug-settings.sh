#!/usr/bin/env bash

# Diagnostic settings are deliberately separate from profiles/*/runners.env:
# changing observability must not invalidate routing coverage or change a route.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/pipeline-store.sh"

debug_settings_uint_valid() {
  [[ "${1:-}" == 0 || "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

debug_settings_now() {
  if [[ "${FACTORY_TESTING:-0}" == 1 ]] &&
    debug_settings_uint_valid "${FACTORY_DEBUG_NOW:-}"; then
    printf '%s\n' "$FACTORY_DEBUG_NOW"
  else
    date +%s
  fi
}

debug_settings_root() {
  if [[ -n "${FACTORY_CONFIG_ROOT:-}" ]]; then
    printf '%s/debug\n' "$FACTORY_CONFIG_ROOT"
  else
    printf '%s/.factory/config/debug\n' "${HOME:?HOME or FACTORY_CONFIG_ROOT is required}"
  fi
}

debug_settings_global_file() {
  printf '%s/global.env\n' "$(debug_settings_root)"
}

debug_settings_profile_file() {
  local profile=${1:?profile}
  [[ "$profile" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 2
  printf '%s/profiles/%s.env\n' "$(debug_settings_root)" "$profile"
}

debug_settings_level_valid() {
  case "${1:-}" in
    inherit|off|errors|decisions|verbose) return 0 ;;
    *) return 1 ;;
  esac
}

debug_settings_get() {
  local file=${1:?settings file} key=${2:?key}
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); value=$0 } END { print value }' \
    "$file" 2>/dev/null
}

debug_settings_validate() {
  local file=${1:?settings file} line key value schema revision level expires
  local -A seen=()
  [[ -f "$file" ]] || return 2
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || return 2
    key=${line%%=*}; value=${line#*=}
    [[ -z "${seen[$key]+present}" ]] || return 2
    seen["$key"]=1
    case "$key" in
      DEBUG_SCHEMA|CONFIG_REVISION|EXPIRES_AT)
        debug_settings_uint_valid "$value" || return 2
        ;;
      LEVEL)
        debug_settings_level_valid "$value" || return 2
        ;;
      *)
        return 2
        ;;
    esac
  done <"$file"
  schema=$(debug_settings_get "$file" DEBUG_SCHEMA)
  revision=$(debug_settings_get "$file" CONFIG_REVISION)
  level=$(debug_settings_get "$file" LEVEL)
  expires=$(debug_settings_get "$file" EXPIRES_AT)
  [[ "$schema" == 1 ]] && debug_settings_uint_valid "$revision" &&
    debug_settings_uint_valid "$expires" || return 2
  debug_settings_level_valid "$level"
}

_debug_settings_path_allowed() {
  local file=${1:?file} root normalized normalized_root
  root=$(debug_settings_root)
  normalized=$(realpath -m -- "$file" 2>/dev/null) || return 1
  normalized_root=$(realpath -m -- "$root" 2>/dev/null) || return 1
  case "$normalized" in
    "$normalized_root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

debug_settings_write() {
  local file=${1:?settings file} expected_revision=${2:?expected revision}
  local level=${3:?level} expires=${4:-0}
  debug_settings_level_valid "$level" || return 2
  debug_settings_uint_valid "$expected_revision" &&
    debug_settings_uint_valid "$expires" || return 2
  _debug_settings_path_allowed "$file" || return 2

  local dir lock_fd current_revision tmp rc=0
  dir=$(dirname "$file")
  mkdir -p "$dir"
  chmod 700 "$(debug_settings_root)" "$dir" 2>/dev/null || true
  exec {lock_fd}>"${file}.lock"
  flock "$lock_fd" || return 1
  if [[ -f "$file" ]]; then
    debug_settings_validate "$file" || {
      flock -u "$lock_fd"
      eval "exec ${lock_fd}>&-"
      return 2
    }
    current_revision=$(debug_settings_get "$file" CONFIG_REVISION)
  else
    current_revision=0
  fi
  if [[ "$current_revision" != "$expected_revision" ]]; then
    flock -u "$lock_fd"
    eval "exec ${lock_fd}>&-"
    return 72
  fi

  tmp=$(mktemp "$dir/.debug-settings.XXXXXX")
  {
    printf 'DEBUG_SCHEMA=1\n'
    printf 'CONFIG_REVISION=%s\n' "$((current_revision + 1))"
    printf 'LEVEL=%s\n' "$level"
    printf 'EXPIRES_AT=%s\n' "$expires"
  } >"$tmp"
  chmod 600 "$tmp"
  sync -f "$tmp" 2>/dev/null || true
  mv -f -- "$tmp" "$file" || rc=$?
  flock -u "$lock_fd"
  eval "exec ${lock_fd}>&-"
  return "$rc"
}

debug_settings_task_write() {
  local task=${1#[tT]} level=${2:?level} expires=${3:-0}
  [[ "$task" =~ ^[0-9]+$ ]] && debug_settings_uint_valid "$expires" || return 2
  debug_settings_level_valid "$level" || return 2
  pipeline_store_update "$task" DEBUG_LEVEL "$level" DEBUG_EXPIRES_AT "$expires"
}

_debug_settings_active() {
  local level=$1 expires=$2 now=$3
  debug_settings_level_valid "$level" || return 2
  debug_settings_uint_valid "$expires" || return 2
  [[ "$level" != inherit && ( "$expires" == 0 || "$expires" -gt "$now" ) ]]
}

_debug_settings_print() {
  printf 'LEVEL=%s\nSOURCE=%s\nEXPIRES_AT=%s\n' "$1" "$2" "$3"
}

debug_settings_resolve() {
  local profile=${1:-} task=${2:-} now=${3:-}
  [[ -n "$now" ]] || now=$(debug_settings_now)
  debug_settings_uint_valid "$now" || return 2
  local file level expires

  if [[ -n "$task" ]]; then
    [[ "${task#[tT]}" =~ ^[0-9]+$ ]] || return 2
    level=$(pipeline_store_get "$task" DEBUG_LEVEL)
    expires=$(pipeline_store_get "$task" DEBUG_EXPIRES_AT)
    [[ -n "$level" ]] || level=inherit
    [[ -n "$expires" ]] || expires=0
    if ! debug_settings_level_valid "$level" || ! debug_settings_uint_valid "$expires"; then
      _debug_settings_print off invalid_task 0
      return 0
    fi
    if _debug_settings_active "$level" "$expires" "$now"; then
      _debug_settings_print "$level" task "$expires"
      return 0
    fi
  fi

  if [[ -n "$profile" ]]; then
    file=$(debug_settings_profile_file "$profile") || return 2
    if [[ -f "$file" ]]; then
      if ! debug_settings_validate "$file"; then
        _debug_settings_print off invalid_profile 0
        return 0
      fi
      level=$(debug_settings_get "$file" LEVEL)
      expires=$(debug_settings_get "$file" EXPIRES_AT)
      if _debug_settings_active "$level" "$expires" "$now"; then
        _debug_settings_print "$level" profile "$expires"
        return 0
      fi
    fi
  fi

  file=$(debug_settings_global_file)
  if [[ -f "$file" ]]; then
    if ! debug_settings_validate "$file"; then
      _debug_settings_print off invalid_global 0
      return 0
    fi
    level=$(debug_settings_get "$file" LEVEL)
    expires=$(debug_settings_get "$file" EXPIRES_AT)
    if _debug_settings_active "$level" "$expires" "$now"; then
      _debug_settings_print "$level" global "$expires"
      return 0
    fi
  fi

  _debug_settings_print off default 0
}

debug_settings_duration_seconds() {
  local duration=${1:-} amount unit seconds
  [[ "$duration" =~ ^([1-9][0-9]*)([smhd])$ ]] || return 2
  amount=${BASH_REMATCH[1]}
  unit=${BASH_REMATCH[2]}
  case "$unit" in
    s) seconds=$amount ;;
    m) seconds=$((amount * 60)) ;;
    h) seconds=$((amount * 3600)) ;;
    d) seconds=$((amount * 86400)) ;;
  esac
  (( seconds > 0 && seconds <= 31536000 )) || return 2
  printf '%s\n' "$seconds"
}
