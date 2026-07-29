#!/usr/bin/env bash

pipeline_store_file() {
  local task=${1#[tT]}
  local active="${STATE_DIR:?}/t${task}.pipeline"
  local archived="$STATE_DIR/archive/t${task}.pipeline"
  if [[ ! -f "$active" && -f "$archived" ]]; then
    printf '%s\n' "$archived"
  else
    printf '%s\n' "$active"
  fi
}

pipeline_store_get() {
  local task=$1 key=$2 file
  file=$(pipeline_store_file "$task")
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); value=$0 } END { print value }' \
    "$file" 2>/dev/null
}

pipeline_lock_acquire() {
  local task=${1#[tT]} output_var=${2:?output variable} new_fd
  mkdir -p "${STATE_DIR:?}"
  exec {new_fd}>"$STATE_DIR/t${task}.pipeline.lock"
  flock "$new_fd" || {
    eval "exec ${new_fd}>&-"
    return 1
  }
  printf -v "$output_var" '%s' "$new_fd"
}

pipeline_lock_release() {
  local fd=${1:?lock fd}
  [[ "$fd" =~ ^[0-9]+$ ]] || return 2
  flock -u "$fd" 2>/dev/null || true
  eval "exec ${fd}>&-"
}

_pipeline_upsert_file() {
  local file=$1 key=$2 value=$3
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 2
  value=${value//$'\n'/ }
  local next="${file}.next.$$"
  if [[ -f "$file" ]]; then
    awk -F= -v key="$key" -v value="$value" '
      BEGIN { replaced=0 }
      $1 == key { if (!replaced) print key "=" value; replaced=1; next }
      { print }
      END { if (!replaced) print key "=" value }
    ' "$file" >"$next" || return
  else
    printf '%s=%s\n' "$key" "$value" >"$next"
  fi
  mv -f -- "$next" "$file"
}

pipeline_store_update_unlocked() {
  local task=$1; shift
  (( $# % 2 == 0 )) || return 2
  local file tmp key value
  file=$(pipeline_store_file "$task")
  mkdir -p "$(dirname "$file")"
  tmp=$(mktemp "$(dirname "$file")/.pipeline.XXXXXX")
  [[ -f "$file" ]] && cp -- "$file" "$tmp"
  while (( $# >= 2 )); do
    key=$1; value=$2; shift 2
    _pipeline_upsert_file "$tmp" "$key" "$value" || {
      rm -f -- "$tmp"
      return 2
    }
  done
  mv -f -- "$tmp" "$file"
}

pipeline_store_update() {
  local task=$1; shift
  local lock_fd rc
  pipeline_lock_acquire "$task" lock_fd || return
  pipeline_store_update_unlocked "$task" "$@"
  rc=$?
  pipeline_lock_release "$lock_fd"
  return "$rc"
}
