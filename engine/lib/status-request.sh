#!/usr/bin/env bash

# Deferred status transport for runners such as Codex whose tool sandbox closes inherited
# file descriptors. The sandbox writes an authenticated-by-context request; runner-launcher,
# which still owns the capability token, validates and applies it outside the sandbox.

_status_request_b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

_status_request_unb64() {
  printf '%s' "$1" | base64 -d 2>/dev/null
}

status_request_expected_dir() {
  local task=${1#[tT]} stage=$2 run_id=$3 state_root
  state_root=${FACTORY_STATE:-${STATE_DIR:-}}
  [[ -n "$state_root" && "$task" =~ ^[0-9]+$ &&
     "$stage" =~ ^[A-Z][A-Z0-9_]*$ &&
     "$run_id" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  printf '%s/logs/runs/t%s/%s/%s/control-requests\n' "$state_root" "$task" "$stage" "$run_id"
}

status_request_context_valid() {
  local task=${1#[tT]} stage=$2 run_id=$3 epoch=$4 expected actual
  [[ "${FACTORY_STATUS_MODE:-}" == request &&
     "${FACTORY_RUN_TASK:-}" == "$task" &&
     "${FACTORY_RUN_STAGE:-}" == "$stage" &&
     "${FACTORY_RUN_ID:-}" == "$run_id" &&
     "${FACTORY_RUN_EPOCH:-}" == "$epoch" ]] || return 1
  expected=$(status_request_expected_dir "$task" "$stage" "$run_id") || return
  actual=${FACTORY_STATUS_REQUEST_DIR:-}
  [[ -n "$actual" && "$(realpath -m -- "$actual" 2>/dev/null)" == \
     "$(realpath -m -- "$expected" 2>/dev/null)" ]]
}

_status_request_write() {
  local dir=$1; shift
  [[ -d "$dir" ]] || return 74
  local tmp final
  tmp=$(mktemp "$dir/.request.XXXXXX") || return 74
  {
    printf '%s\n' "$@"
  } >"$tmp"
  chmod 600 "$tmp" 2>/dev/null || true
  final="$dir/$(date +%s%N)-$$-$RANDOM.request"
  mv -f -- "$tmp" "$final"
}

status_request_result() {
  local task=${1#[tT]} stage=$2 run_id=$3 epoch=$4 result=$5 comment=${6:-} dir
  case "$result" in done|skipped|failed) ;; *) return 2 ;; esac
  status_request_context_valid "$task" "$stage" "$run_id" "$epoch" || return 74
  dir=$(status_request_expected_dir "$task" "$stage" "$run_id") || return
  _status_request_write "$dir" \
    "SCHEMA=1" "TYPE=result" "TASK=$task" "STAGE=$stage" "RUN_ID=$run_id" \
    "EPOCH=$epoch" "RESULT=$result" "COMMENT_B64=$(_status_request_b64 "$comment")"
}

status_request_progress() {
  local task=${1#[tT]} stage=$2 run_id=$3 epoch=$4; shift 4
  (( $# >= 2 && $# % 2 == 0 )) || return 2
  status_request_context_valid "$task" "$stage" "$run_id" "$epoch" || return 74
  local dir count=$(( $# / 2 )) index=0 key value
  local -a lines=(
    "SCHEMA=1" "TYPE=progress" "TASK=$task" "STAGE=$stage" "RUN_ID=$run_id"
    "EPOCH=$epoch" "COUNT=$count"
  )
  while (( $# >= 2 )); do
    key=$1; value=$2; shift 2
    lines+=("KEY_${index}=$key" "VALUE_${index}_B64=$(_status_request_b64 "$value")")
    index=$((index + 1))
  done
  dir=$(status_request_expected_dir "$task" "$stage" "$run_id") || return
  _status_request_write "$dir" "${lines[@]}"
}

status_request_consume_all() {
  local task=${1#[tT]} stage=$2 run_id=$3 epoch=$4 token=$5 dir=$6
  local request schema type req_task req_stage req_run req_epoch count index key encoded value
  local result comment rc
  local -a requests=() pairs=()
  [[ -d "$dir" ]] || return 0
  mapfile -t requests < <(find "$dir" -maxdepth 1 -type f -name '*.request' -print | LC_ALL=C sort)
  for request in "${requests[@]}"; do
    schema=$(_run_state_get "$request" SCHEMA)
    type=$(_run_state_get "$request" TYPE)
    req_task=$(_run_state_get "$request" TASK)
    req_stage=$(_run_state_get "$request" STAGE)
    req_run=$(_run_state_get "$request" RUN_ID)
    req_epoch=$(_run_state_get "$request" EPOCH)
    [[ "$schema" == 1 && "$req_task" == "$task" && "$req_stage" == "$stage" &&
       "$req_run" == "$run_id" && "$req_epoch" == "$epoch" ]] || return 74
    case "$type" in
      progress)
        count=$(_run_state_get "$request" COUNT)
        [[ "$count" =~ ^[0-9]+$ && "$count" -le 64 ]] || return 74
        pairs=()
        for (( index=0; index<count; index++ )); do
          key=$(_run_state_get "$request" "KEY_${index}")
          encoded=$(_run_state_get "$request" "VALUE_${index}_B64")
          value=$(_status_request_unb64 "$encoded") || return 74
          pairs+=("$key" "$value")
        done
        run_state_apply_progress "$task" "$stage" "$run_id" "$epoch" "$token" "${pairs[@]}"
        rc=$?
        ;;
      result)
        result=$(_run_state_get "$request" RESULT)
        encoded=$(_run_state_get "$request" COMMENT_B64)
        comment=$(_status_request_unb64 "$encoded") || return 74
        run_state_apply_result "$task" "$stage" "$run_id" "$epoch" "$token" "$result" "$comment"
        rc=$?
        ;;
      *) return 74 ;;
    esac
    case "$rc" in
      0|75) rm -f -- "$request" ;;
      *) return "$rc" ;;
    esac
  done
}
