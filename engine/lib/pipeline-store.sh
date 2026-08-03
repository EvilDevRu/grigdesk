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

_pipeline_strip_stage_family() {
  local file=$1 stage=$2 next
  [[ "$stage" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]] || return 2
  next=$(mktemp "${file}.strip.XXXXXX") || return 1
  awk -F= -v stage="$stage" '
    {
      key=$1
      if (key == stage || key == stage "_COMMENT" || key == stage "_AT" ||
          key == stage "_FAILS" || key == "ACTIVE_RUN_" stage ||
          key == "ACTIVE_EPOCH_" stage || key == "RUNNER_ACTUAL_" stage ||
          key == "RUNNER_REASON_" stage || key == "RUNNER_REQUESTED_" stage ||
          key == "RUNNER_FAILOVER_" stage || key == "RUNNER_OVERRIDE_STAGE_" stage ||
          key == "MODEL_FAMILY_" stage || key == "MODEL_ACTUAL_" stage ||
          key == "CATALOG_REVISION_" stage || key == "PLAN_LEVEL_" stage ||
          key == "FANOUT_" stage)
        next
      print
    }
  ' "$file" >"$next" || {
    rm -f -- "$next"
    return 1
  }
  mv -f -- "$next" "$file"
}

# Атомарно создаёт/переинициализирует вторичный route-реестр из exact списка
# runKey закреплённой machine. Это внутренний control writer: публичный
# pipeline-set не владеет ни topology, ни pinned metadata попытки.
pipeline_store_route_init() {
  local task=${1#[tT]} stages=${2:-} lock_fd file tmp key value rc=0
  shift 2 || return 2
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ && -n "$stages" ]] || return 2
  (( $# % 2 == 0 )) || return 2
  local -A seen=() prior_stages=() reset_stages=()
  for key in $stages; do
    [[ "$key" =~ ^[A-Z][A-Z0-9_]{0,63}$ && -z "${seen[$key]:-}" ]] || return 2
    seen[$key]=1
  done
  pipeline_lock_acquire "$task" lock_fd || return
  file="${STATE_DIR:?}/t${task}.pipeline"
  if [[ -L "$file" ]] || [[ -e "$file" && ! -f "$file" ]]; then
    pipeline_lock_release "$lock_fd"
    return 78
  fi
  tmp=$(mktemp "$STATE_DIR/.t${task}.pipeline-init.XXXXXX") || {
    pipeline_lock_release "$lock_fd"
    return 1
  }
  if [[ -f "$file" ]]; then
    cp -- "$file" "$tmp" || rc=$?
  fi
  if (( rc == 0 )) && [[ -s "$tmp" ]]; then
    # Старый exact registry сам сообщает свои runKeys их status-значениями.
    # Control-поля с похожими значениями (WF_STATUS/decisions/delivery) узлами не являются.
    while IFS='=' read -r key value; do
      case "$value" in
        pending|running|waiting|approved|rejected|done|failed|skipped)
          case "$key" in
            WF_STATUS|RESULT|DELIVERY_MODE|PLAN_DECISION|CAUSE_DECISION|ACCEPTANCE_DECISION)
              ;;
            *)
              [[ "$key" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]] && prior_stages[$key]=1
              ;;
          esac
          ;;
      esac
    done <"$tmp"
  fi
  for key in "${!prior_stages[@]}" "${!seen[@]}"; do
    [[ -n "$key" ]] && reset_stages[$key]=1
  done
  if (( rc == 0 )); then
    # Recovery может закрепить другую machine. Удаляем не только старые status keys,
    # но и comments/run identity/provider provenance: иначе pending-узел выглядит
    # выполненным старым runner-ом, а исчезнувший узел остаётся phantom metadata.
    for key in "${!reset_stages[@]}"; do
      _pipeline_strip_stage_family "$tmp" "$key" || { rc=$?; break; }
    done
  fi
  if (( rc == 0 )); then
    # Эти значения публикуются вместе одним final rename: новая задача никогда
    # не видна как реестр без route protocol marker.
    _pipeline_upsert_file "$tmp" RUN_PROTOCOL 2 || rc=$?
    _pipeline_upsert_file "$tmp" WF_STATUS running || rc=$?
  fi
  if (( rc == 0 )); then
    for key in $stages; do
      _pipeline_upsert_file "$tmp" "$key" pending || { rc=$?; break; }
    done
  fi
  if (( rc == 0 )); then
    while (( $# >= 2 )); do
      _pipeline_upsert_file "$tmp" "$1" "$2" || { rc=$?; break; }
      shift 2
    done
  fi
  if (( rc == 0 )); then
    chmod 600 "$tmp" || rc=$?
  fi
  if (( rc == 0 )); then
    mv -f -- "$tmp" "$file" || rc=$?
  fi
  [[ ! -e "$tmp" ]] || rm -f -- "$tmp"
  pipeline_lock_release "$lock_fd"
  return "$rc"
}
