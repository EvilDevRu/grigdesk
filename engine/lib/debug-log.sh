#!/usr/bin/env bash

# Typed, optional diagnostic trace. Product state and runner decisions must never
# depend on this module succeeding.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/debug-settings.sh"

DEBUG_LOG_PROFILE=""
DEBUG_LOG_TASK=""
DEBUG_LOG_STAGE=""
DEBUG_LOG_RUN_DIR=""
DEBUG_LOG_RUN_ID=""
DEBUG_LOG_EPOCH=""
DEBUG_LOG_LEVEL=off
DEBUG_LOG_SOURCE=default
DEBUG_LOG_DROPPED=0
DEBUG_LOG_CLOSED=1

_debug_log_rank() {
  case "${1:-off}" in
    off) printf '0\n' ;;
    errors) printf '1\n' ;;
    decisions) printf '2\n' ;;
    verbose) printf '3\n' ;;
    *) return 2 ;;
  esac
}

_debug_log_field_valid() {
  local key=${1:-} value=${2:-}
  case "$key" in
    task|epoch|started|rc|elapsed_ms|pid|pgid|attempt|expires_at|partial)
      [[ "$value" =~ ^[0-9]+$ ]]
      ;;
    profile|stage|run_id|runner|model|family|effort|catalog_revision|plan_level|route_source|\
    primary|failover|result|reason|phase|scope|source|level|signal|dropped)
      [[ "$value" =~ ^[A-Za-z0-9._:/,@+=-]*$ ]]
      ;;
    *)
      return 1
      ;;
  esac
}

_debug_log_meta_once() {
  local key=$1 value=$2 meta="$DEBUG_LOG_RUN_DIR/meta.env"
  [[ -f "$meta" ]] || return 0
  grep -q "^${key}=" "$meta" 2>/dev/null && return 0
  printf '%s=%s\n' "$key" "$value" >>"$meta" 2>/dev/null || true
  chmod 600 "$meta" 2>/dev/null || true
}

_debug_log_mark_dropped() {
  local reason=${1:-write_error}
  (( DEBUG_LOG_DROPPED == 0 )) || return 0
  DEBUG_LOG_DROPPED=1
  _debug_log_meta_once DEBUG_DROPPED "$reason"
}

_debug_log_append() {
  local event=${1:?event}; shift
  [[ "$event" =~ ^[a-z][a-z0-9_]*$ ]] || return 2
  (( $# % 2 == 0 )) || return 2
  local key value line ts max_bytes current_size
  line="{\"ts\":\"$(debug_settings_now)\",\"event\":\"$event\""
  while (( $# >= 2 )); do
    key=$1; value=$2; shift 2
    _debug_log_field_valid "$key" "$value" || return 2
    line+=",\"$key\":\"$value\""
  done
  line+="}"

  (( DEBUG_LOG_DROPPED == 0 )) || return 0
  max_bytes=${FACTORY_DEBUG_MAX_BYTES:-1048576}
  [[ "$max_bytes" =~ ^[0-9]+$ && "$max_bytes" -ge 256 ]] || max_bytes=1048576
  current_size=$(stat -c %s "$DEBUG_LOG_RUN_DIR/debug.trace.jsonl" 2>/dev/null || printf '0')
  if (( current_size + ${#line} + 1 > max_bytes )); then
    _debug_log_mark_dropped size_limit
    return 0
  fi
  if ! printf '%s\n' "$line" >>"$DEBUG_LOG_RUN_DIR/debug.trace.jsonl" 2>/dev/null; then
    _debug_log_mark_dropped write_error
    return 0
  fi
  chmod 600 "$DEBUG_LOG_RUN_DIR/debug.trace.jsonl" 2>/dev/null || true
}

debug_log_cleanup() {
  local root=${1:?runs root} now=${2:?now} retention=${3:?retention}
  [[ "$now" =~ ^[0-9]+$ && "$retention" =~ ^[0-9]+$ ]] || return 2
  local allowed normalized file mtime
  allowed=$(realpath -m -- "${STATE_DIR:?}/logs/runs" 2>/dev/null) || return 2
  normalized=$(realpath -m -- "$root" 2>/dev/null) || return 2
  [[ "$normalized" == "$allowed" ]] || return 2
  [[ -d "$normalized" ]] || return 0
  while IFS= read -r -d '' file; do
    mtime=$(stat -c %Y "$file" 2>/dev/null || continue)
    if (( now > mtime && now - mtime > retention )); then
      rm -f -- "$file"
    fi
  done < <(find "$normalized" -type f -name debug.trace.jsonl -print0 2>/dev/null)
}

_debug_log_cleanup_maybe() {
  local root="${STATE_DIR:?}/logs/runs" state_root="${STATE_DIR:?}/logs"
  local stamp="$state_root/.debug-cleanup" lock="$state_root/.debug-cleanup.lock"
  local now retention last=0
  now=$(debug_settings_now)
  retention=${FACTORY_DEBUG_RETENTION_SECONDS:-604800}
  [[ "$retention" =~ ^[0-9]+$ ]] || retention=604800
  mkdir -p "$state_root"
  [[ -f "$stamp" ]] && last=$(stat -c %Y "$stamp" 2>/dev/null || printf '0')
  (( now >= last && now - last < 3600 )) && return 0
  mkdir "$lock" 2>/dev/null || return 0
  debug_log_cleanup "$root" "$now" "$retention" || true
  touch "$stamp" 2>/dev/null || true
  rmdir "$lock" 2>/dev/null || true
}

_debug_log_open_trace() {
  mkdir -p "$DEBUG_LOG_RUN_DIR" || return 1
  if [[ ! -f "$DEBUG_LOG_RUN_DIR/debug.trace.jsonl" ]]; then
    : >"$DEBUG_LOG_RUN_DIR/debug.trace.jsonl" || return 1
  fi
  chmod 600 "$DEBUG_LOG_RUN_DIR/debug.trace.jsonl" 2>/dev/null || true
  DEBUG_LOG_CLOSED=0
}

_debug_log_resolve() {
  local resolved
  resolved=$(debug_settings_resolve "$DEBUG_LOG_PROFILE" "$DEBUG_LOG_TASK" \
    "$(debug_settings_now)") || return
  DEBUG_LOG_RESOLVED_LEVEL=$(awk -F= '$1=="LEVEL"{print $2}' <<<"$resolved")
  DEBUG_LOG_RESOLVED_SOURCE=$(awk -F= '$1=="SOURCE"{print $2}' <<<"$resolved")
  DEBUG_LOG_RESOLVED_EXPIRES=$(awk -F= '$1=="EXPIRES_AT"{print $2}' <<<"$resolved")
}

debug_log_init() {
  DEBUG_LOG_PROFILE=${1:-}
  DEBUG_LOG_TASK=${2#[tT]}
  DEBUG_LOG_STAGE=${3:?stage}
  DEBUG_LOG_RUN_DIR=${4:?run dir}
  DEBUG_LOG_RUN_ID=${5:?run id}
  DEBUG_LOG_EPOCH=${6:?epoch}
  DEBUG_LOG_LEVEL=off
  DEBUG_LOG_SOURCE=default
  DEBUG_LOG_DROPPED=0
  DEBUG_LOG_CLOSED=1
  _debug_log_cleanup_maybe
  _debug_log_resolve || {
    _debug_log_meta_once DEBUG_LEVEL off
    _debug_log_meta_once DEBUG_SOURCE invalid
    return 0
  }
  DEBUG_LOG_LEVEL=$DEBUG_LOG_RESOLVED_LEVEL
  DEBUG_LOG_SOURCE=$DEBUG_LOG_RESOLVED_SOURCE
  _debug_log_meta_once DEBUG_LEVEL "$DEBUG_LOG_LEVEL"
  _debug_log_meta_once DEBUG_SOURCE "$DEBUG_LOG_SOURCE"
  if [[ "$DEBUG_LOG_LEVEL" != off ]]; then
    if _debug_log_open_trace; then
      _debug_log_append debug_started level "$DEBUG_LOG_LEVEL" source "$DEBUG_LOG_SOURCE" \
        partial 0 || _debug_log_mark_dropped write_error
    else
      _debug_log_mark_dropped write_error
    fi
  fi
  return 0
}

debug_log_event() {
  local required=${1:?required level} event=${2:?event}; shift 2
  local key value
  _debug_log_rank "$required" >/dev/null || return 2
  [[ "$event" =~ ^[a-z][a-z0-9_]*$ ]] || return 2
  (( $# % 2 == 0 )) || return 2
  local -a fields=("$@")
  while (( $# >= 2 )); do
    key=$1; value=$2; shift 2
    _debug_log_field_valid "$key" "$value" || return 2
  done

  _debug_log_resolve || return 0
  if [[ "$DEBUG_LOG_RESOLVED_LEVEL" == off ]]; then
    if [[ "$DEBUG_LOG_LEVEL" != off && "$DEBUG_LOG_CLOSED" == 0 ]]; then
      _debug_log_append debug_disabled source "$DEBUG_LOG_RESOLVED_SOURCE" || true
    fi
    DEBUG_LOG_LEVEL=off
    DEBUG_LOG_SOURCE=$DEBUG_LOG_RESOLVED_SOURCE
    DEBUG_LOG_CLOSED=1
    return 0
  fi

  if [[ "$DEBUG_LOG_LEVEL" == off || "$DEBUG_LOG_CLOSED" == 1 ]]; then
    _debug_log_open_trace || {
      _debug_log_mark_dropped write_error
      return 0
    }
    DEBUG_LOG_LEVEL=$DEBUG_LOG_RESOLVED_LEVEL
    DEBUG_LOG_SOURCE=$DEBUG_LOG_RESOLVED_SOURCE
    _debug_log_append debug_enabled level "$DEBUG_LOG_LEVEL" source "$DEBUG_LOG_SOURCE" \
      partial 1 || true
  elif [[ "$DEBUG_LOG_LEVEL" != "$DEBUG_LOG_RESOLVED_LEVEL" ]]; then
    DEBUG_LOG_LEVEL=$DEBUG_LOG_RESOLVED_LEVEL
    DEBUG_LOG_SOURCE=$DEBUG_LOG_RESOLVED_SOURCE
    _debug_log_append debug_level_changed level "$DEBUG_LOG_LEVEL" source "$DEBUG_LOG_SOURCE" \
      || true
  fi

  local required_rank current_rank
  required_rank=$(_debug_log_rank "$required") || return 2
  current_rank=$(_debug_log_rank "$DEBUG_LOG_LEVEL") || return 0
  (( current_rank >= required_rank )) || return 0
  _debug_log_append "$event" "${fields[@]}"
}

debug_log_event_for() {
  local task=${1#[tT]} stage=${2:?stage}
  shift 2
  [[ "$task" =~ ^[0-9]+$ && "$stage" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 2
  [[ "$DEBUG_LOG_TASK" == "$task" && "$DEBUG_LOG_STAGE" == "$stage" &&
     -n "$DEBUG_LOG_RUN_DIR" ]] || return 0
  debug_log_event "$@"
}
