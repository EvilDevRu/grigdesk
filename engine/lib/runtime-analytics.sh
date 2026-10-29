#!/usr/bin/env bash
# Lifecycle-контекст на стороне хоста и строгие помощники для черновиков событий.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/attempt-lifecycle-state.sh"

runtime_analytics_python_v2() {
  command -v python3 >/dev/null 2>&1 || return 78
  python3 "$FACTORY_HOME/lib/runtime-analytics.py" "$@"
}

runtime_analytics_id_v2() {
  runtime_analytics_python_v2 id "$@"
}

runtime_analytics_now_v2() {
  runtime_analytics_python_v2 now
}

runtime_analytics_json_v2() {
  runtime_analytics_python_v2 json "$@"
}

runtime_analytics_hash_string_v2() {
  runtime_analytics_python_v2 hash-string "${1-}"
}

runtime_analytics_hash_file_v2() {
  runtime_analytics_python_v2 hash-file "${1:-}"
}

runtime_analytics_durable_replace_v2() {
  runtime_analytics_python_v2 durable-replace "${1:-}" "${2:-}"
}

runtime_analytics_durable_unlink_v2() {
  runtime_analytics_python_v2 durable-unlink "${1:-}"
}

runtime_analytics_json_get_v2() {
  runtime_analytics_python_v2 get "${1:-}" "${2:-}"
}

# Представляет составную ссылку [маршрут, модель] строгим идентификатором lifecycle.
# Остальные значения сохраняются для проверки схемой; контракт запуска раннера не меняется.
runtime_lifecycle_model_id_v2() {
  jq -nr --arg model "${1-}" '
    ($model | try fromjson catch null) as $reference
    | if ($reference | type) == "array"
        and ($reference | length) == 2
        and all($reference[]; type == "string")
      then $reference | join("/")
      else $model
      end
  '
}

runtime_lifecycle_enabled_v2() {
  [[ -n "${FACTORY_LIFECYCLE_TASK_ID:-}" &&
     -n "${FACTORY_LIFECYCLE_ATTEMPT_ID:-}" &&
     -n "${FACTORY_LIFECYCLE_PROFILE:-}" &&
     -n "${FACTORY_LIFECYCLE_SESSION_ID:-}" ]]
}

runtime_lifecycle_set_context_v2() {
  local task=${1#[tT]} attempt=$2 profile=$3 route_id=${4:-} route_hash=${5:-}
  local session_id=${6:-}
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ &&
     "$attempt" =~ ^a_[a-f0-9]{32}$ &&
     "$profile" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || return 2
  if [[ -n "$route_id" || -n "$route_hash" ]]; then
    [[ "$route_id" =~ ^[a-z0-9][a-z0-9_-]{0,40}$ &&
       "$route_hash" =~ ^[a-f0-9]{64}$ ]] || return 2
  fi
  if [[ -z "$session_id" ]]; then
    local process_start
    process_start=$(awk '{ tail=$0; sub(/^.*\) /,"",tail); split(tail,f," "); print f[20] }' \
      "/proc/$BASHPID/stat" 2>/dev/null) || return 78
    session_id=$(runtime_analytics_id_v2 os "$attempt" "$$" "$BASHPID" "$process_start") || return
  fi
  [[ "$session_id" =~ ^os_[a-f0-9]{32}$ ]] || return 2
  export FACTORY_LIFECYCLE_TASK_ID="t$task"
  export FACTORY_LIFECYCLE_ATTEMPT_ID=$attempt
  export FACTORY_LIFECYCLE_PROFILE=$profile
  export FACTORY_LIFECYCLE_ROUTE_ID=$route_id
  export FACTORY_LIFECYCLE_ROUTE_HASH=$route_hash
  export FACTORY_LIFECYCLE_SESSION_ID=$session_id
  printf '%s\n' "$session_id"
}

runtime_lifecycle_set_route_v2() {
  local route_id=${1:-} route_hash=${2:-}
  [[ "$route_id" =~ ^[a-z0-9][a-z0-9_-]{0,40}$ &&
     "$route_hash" =~ ^[a-f0-9]{64}$ ]] || return 2
  export FACTORY_LIFECYCLE_ROUTE_ID=$route_id
  export FACTORY_LIFECYCLE_ROUTE_HASH=$route_hash
}

runtime_lifecycle_clear_entity_v2() {
  unset FACTORY_LIFECYCLE_NODE_VISIT_ID FACTORY_LIFECYCLE_NODE_EXECUTION_ID
  unset FACTORY_LIFECYCLE_NODE_ID FACTORY_LIFECYCLE_RUN_KEY
  unset FACTORY_LIFECYCLE_DISPATCH_ID FACTORY_LIFECYCLE_RUN_ID
  unset FACTORY_LIFECYCLE_EPOCH FACTORY_LIFECYCLE_SPAN_ID
}

runtime_lifecycle_previous_session_v2() {
  local task=${1#[tT]} attempt=$2
  attempt_lifecycle_read_v2 "$task" "$attempt" | python3 -c '
import json, sys
last = None
for raw in sys.stdin:
    event = json.loads(raw)
    if event.get("kind") == "orchestrator_session_started":
        last = event.get("orchestratorSessionId")
if last is None:
    raise SystemExit(3)
print(last)
'
}

# Возвращает последний старт сессии без соответствующего завершения и без точной
# метки crash_detected от более позднего писателя. Это только чтение; новая writable
# сессия сама решает, дописывать ли событие прерывания.
# Диагностика поиска при кодах 0 и 3 отбрасывается: отсутствие сессии штатно.
# Остальные ошибки остаются в stderr, чтобы повреждение журнала не стало тихим отказом.
runtime_lifecycle_previous_open_session_v2() {
  local task=${1#[tT]} attempt=$2 output=$3 root ledger stderr_file rc
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ &&
     "$attempt" =~ ^a_[a-f0-9]{32}$ && -n "$output" ]] || return 2
  root=$(factory_control_root) || return
  ledger=$(mktemp "$root/.runtime-lifecycle-session.XXXXXX") || return 1
  stderr_file=$(mktemp "$root/.runtime-lifecycle-session-stderr.XXXXXX") || {
    rm -f -- "$ledger"
    return 1
  }

  attempt_lifecycle_read_v2 "$task" "$attempt" >"$ledger"
  rc=$?

  if (( rc == 0 )); then
    runtime_analytics_python_v2 find-open-session "$ledger" >"$output" 2>"$stderr_file"
    rc=$?

    if (( rc != 0 && rc != 3 )); then
      cat -- "$stderr_file" >&2
    fi
  fi

  rm -f -- "$ledger" "$stderr_file"
  return "$rc"
}

runtime_lifecycle_emit_v2() {
  local kind=${1:-} details=${2:-} event_key=${3:-default} span_id=${4:-}
  local task attempt root draft hash rc
  runtime_lifecycle_enabled_v2 || return 0
  task=${FACTORY_LIFECYCLE_TASK_ID#t}
  attempt=$FACTORY_LIFECYCLE_ATTEMPT_ID
  root=$(factory_control_root) || return
  draft=$(mktemp "$root/.runtime-lifecycle.XXXXXX") || return 1
  runtime_analytics_python_v2 event "$kind" "$details" "$event_key" "$span_id" >"$draft" || {
    rc=$?
    rm -f -- "$draft"
    return "$rc"
  }
  hash=$(attempt_lifecycle_append_v2 "$task" "$attempt" "$draft")
  rc=$?
  rm -f -- "$draft"
  (( rc == 0 )) || return "$rc"
  RUNTIME_LIFECYCLE_LAST_EVENT_HASH=$hash
  export RUNTIME_LIFECYCLE_LAST_EVENT_HASH
  printf '%s\n' "$hash"
}

runtime_lifecycle_duration_ms_v2() {
  local started=${1:-} ended=${2:-}
  [[ "$started" =~ ^[0-9]+$ && "$ended" =~ ^[0-9]+$ && "$ended" -ge "$started" ]] || return 2
  printf '%s\n' "$(( (ended - started) / 1000000 ))"
}

RUNTIME_LIFECYCLE_SESSION_STARTED_NS=""
RUNTIME_LIFECYCLE_SESSION_SPAN_ID=""
RUNTIME_LIFECYCLE_SESSION_ROUTE_ID=""
RUNTIME_LIFECYCLE_SESSION_ROUTE_HASH=""
declare -gA RUNTIME_LIFECYCLE_ATTEMPT_SPAN_STARTED_NS=()
declare -gA RUNTIME_LIFECYCLE_ATTEMPT_SPAN_ID=()

runtime_lifecycle_session_begin_v2() {
  local reason=$1 previous=${2:-} at mono boot process details
  runtime_lifecycle_enabled_v2 || return 0
  case "$reason" in initial|resume|recovery) ;; *) return 2 ;; esac
  runtime_lifecycle_clear_entity_v2
  RUNTIME_LIFECYCLE_SESSION_SPAN_ID=$(runtime_analytics_id_v2 sp \
    "$FACTORY_LIFECYCLE_SESSION_ID" session) || return
  export RUNTIME_LIFECYCLE_SESSION_SPAN_ID
  process=$(runtime_analytics_python_v2 process "$BASHPID") || return
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  RUNTIME_LIFECYCLE_SESSION_STARTED_NS=$mono
  export RUNTIME_LIFECYCLE_SESSION_STARTED_NS
  RUNTIME_LIFECYCLE_SESSION_ROUTE_ID=${FACTORY_LIFECYCLE_ROUTE_ID:-}
  RUNTIME_LIFECYCLE_SESSION_ROUTE_HASH=${FACTORY_LIFECYCLE_ROUTE_HASH:-}
  details=$(runtime_analytics_json_v2 \
    sessionReason string "$reason" \
    previousSessionId "$([[ -n "$previous" ]] && printf string || printf null)" "${previous:-null}" \
    process json "$process") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 orchestrator_session_started "$details" \
      "$FACTORY_LIFECYCLE_SESSION_ID:start" "$RUNTIME_LIFECYCLE_SESSION_SPAN_ID"
}

runtime_lifecycle_session_finish_v2() {
  local status=$1 reason=$2 evidence=${3:-} at mono boot duration details evidence_type=null
  runtime_lifecycle_enabled_v2 || return 0
  [[ -n "$RUNTIME_LIFECYCLE_SESSION_STARTED_NS" ]] || return 0
  runtime_lifecycle_clear_entity_v2
  [[ -n "$evidence" ]] && evidence_type=string
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  duration=$(runtime_lifecycle_duration_ms_v2 "$RUNTIME_LIFECYCLE_SESSION_STARTED_NS" "$mono") || return
  details=$(runtime_analytics_json_v2 \
    status string "$status" reasonCode string "$reason" reasonTextSha256 null null \
    durationMs integer "$duration" durationFidelity string monotonic \
    evidenceSha256 "$evidence_type" "${evidence:-null}") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 orchestrator_session_finished "$details" \
      "$FACTORY_LIFECYCLE_SESSION_ID:finish" "$RUNTIME_LIFECYCLE_SESSION_SPAN_ID"
}

runtime_lifecycle_attempt_started_v2() {
  local origin=$1 previous=${2:-} recovery_hash=${3:-} record_hash=$4 details
  runtime_lifecycle_enabled_v2 || return 0
  runtime_lifecycle_clear_entity_v2
  details=$(runtime_analytics_json_v2 \
    origin string "$origin" \
    previousAttemptId "$([[ -n "$previous" ]] && printf string || printf null)" "${previous:-null}" \
    recoveryReasonSha256 "$([[ -n "$recovery_hash" ]] && printf string || printf null)" "${recovery_hash:-null}" \
    attemptRecordSha256 string "$record_hash") || return
  runtime_lifecycle_emit_v2 attempt_started "$details" \
    "$FACTORY_LIFECYCLE_ATTEMPT_ID:started" -
}

runtime_lifecycle_attempt_resumed_v2() {
  local previous=$1 reason=${2:-operator} evidence=${3:-} details evidence_type=null
  runtime_lifecycle_enabled_v2 || return 0
  runtime_lifecycle_clear_entity_v2
  [[ -n "$evidence" ]] && evidence_type=string
  details=$(runtime_analytics_json_v2 \
    resumeReason string "$reason" previousSessionId string "$previous" \
    evidenceSha256 "$evidence_type" "${evidence:-null}") || return
  runtime_lifecycle_emit_v2 attempt_resumed "$details" \
    "$FACTORY_LIFECYCLE_SESSION_ID:attempt-resumed" -
}

runtime_lifecycle_attempt_interrupted_v2() {
  local reason=$1 evidence=${2:-} details evidence_type=null
  runtime_lifecycle_enabled_v2 || return 0
  runtime_lifecycle_clear_entity_v2
  [[ -n "$evidence" ]] && evidence_type=string
  details=$(runtime_analytics_json_v2 reasonCode string "$reason" \
    evidenceSha256 "$evidence_type" "${evidence:-null}") || return
  runtime_lifecycle_emit_v2 attempt_interrupted "$details" \
    "$FACTORY_LIFECYCLE_SESSION_ID:attempt-interrupted:$reason" -
}

runtime_lifecycle_route_selected_v2() {
  local catalog=$1 pin_hash=$2 selected_at=$3 source=$4 details
  runtime_lifecycle_enabled_v2 || return 0
  runtime_lifecycle_clear_entity_v2
  details=$(runtime_analytics_json_v2 \
    catalogHash string "$catalog" routePinSha256 string "$pin_hash" \
    selectedAt string "$selected_at" selectionSource string "$source") || return
  runtime_lifecycle_emit_v2 route_selected "$details" \
    "$FACTORY_LIFECYCLE_ATTEMPT_ID:route-selected:$pin_hash" -
}

runtime_lifecycle_attempt_terminal_v2() {
  local state=$1 reason=$2 reason_hash=${3:-} record_hash=$4 closed_at=$5 details
  local reason_type=null
  runtime_lifecycle_enabled_v2 || return 0
  runtime_lifecycle_clear_entity_v2
  [[ -n "$reason_hash" ]] && reason_type=string
  details=$(runtime_analytics_json_v2 \
    terminalState string "$state" terminalReasonCode string "$reason" \
    terminalReasonSha256 "$reason_type" "${reason_hash:-null}" \
    terminalRecordSha256 string "$record_hash" closedAt string "$closed_at") || return
  runtime_lifecycle_emit_v2 attempt_terminal_recorded "$details" \
    "$FACTORY_LIFECYCLE_ATTEMPT_ID:terminal:$record_hash" -
}

runtime_lifecycle_attempt_span_begin_v2() {
  local kind=$1 key=$2 details=$3 at mono boot span
  runtime_lifecycle_enabled_v2 || return 0
  runtime_lifecycle_clear_entity_v2
  span=$(runtime_analytics_id_v2 sp "$FACTORY_LIFECYCLE_SESSION_ID" "$key") || return
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  RUNTIME_LIFECYCLE_ATTEMPT_SPAN_STARTED_NS["$key"]=$mono
  RUNTIME_LIFECYCLE_ATTEMPT_SPAN_ID["$key"]=$span
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 "$kind" "$details" "$key:start" "$span"
}

runtime_lifecycle_attempt_span_finish_v2() {
  local kind=$1 key=$2 status=$3 reason=$4 evidence=${5:-}
  local at mono boot duration details evidence_type=null
  runtime_lifecycle_enabled_v2 || return 0
  runtime_lifecycle_clear_entity_v2
  [[ -n "${RUNTIME_LIFECYCLE_ATTEMPT_SPAN_STARTED_NS[$key]:-}" ]] || return 3
  [[ -n "$evidence" ]] && evidence_type=string
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  duration=$(runtime_lifecycle_duration_ms_v2 \
    "${RUNTIME_LIFECYCLE_ATTEMPT_SPAN_STARTED_NS[$key]}" "$mono") || return
  details=$(runtime_analytics_json_v2 \
    status string "$status" reasonCode string "$reason" reasonTextSha256 null null \
    durationMs integer "$duration" durationFidelity string monotonic \
    evidenceSha256 "$evidence_type" "${evidence:-null}") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 "$kind" "$details" "$key:finish" \
      "${RUNTIME_LIFECYCLE_ATTEMPT_SPAN_ID[$key]}"
}

RUNTIME_LIFECYCLE_VISIT_STARTED_NS=""
RUNTIME_LIFECYCLE_VISIT_STARTED_AT=""
RUNTIME_LIFECYCLE_VISIT_SPAN_ID=""
RUNTIME_LIFECYCLE_EXECUTION_STARTED_NS=""
RUNTIME_LIFECYCLE_EXECUTION_SPAN_ID=""
RUNTIME_LIFECYCLE_COMMAND_STARTED_NS=""
RUNTIME_LIFECYCLE_COMMAND_SPAN_ID=""
RUNTIME_LIFECYCLE_DISPATCH_STARTED_NS=""
RUNTIME_LIFECYCLE_DISPATCH_SPAN_ID=""

runtime_lifecycle_node_visit_begin_v2() {
  local node=$1 run_key=$2 ordinal=$3 reason=${4:-initial}
  local transition=${5:-} stage_hash=${6:-} at mono boot details
  runtime_lifecycle_enabled_v2 || return 0
  [[ "$ordinal" =~ ^[0-9]+$ ]] || return 2
  case "$reason" in
    initial|forward_transition|route_rewind|gate_rejected|human_rewind|recovery) ;;
    *) return 2 ;;
  esac
  export FACTORY_LIFECYCLE_NODE_ID=$node FACTORY_LIFECYCLE_RUN_KEY=$run_key
  FACTORY_LIFECYCLE_NODE_VISIT_ID=$(runtime_analytics_id_v2 nv \
    "$FACTORY_LIFECYCLE_ATTEMPT_ID" "$FACTORY_LIFECYCLE_SESSION_ID" \
    "$node" "$run_key" "$ordinal" "$reason") || return
  export FACTORY_LIFECYCLE_NODE_VISIT_ID
  unset FACTORY_LIFECYCLE_NODE_EXECUTION_ID FACTORY_LIFECYCLE_DISPATCH_ID
  unset FACTORY_LIFECYCLE_RUN_ID FACTORY_LIFECYCLE_EPOCH
  RUNTIME_LIFECYCLE_VISIT_SPAN_ID=$(runtime_analytics_id_v2 sp \
    "$FACTORY_LIFECYCLE_NODE_VISIT_ID" visit) || return
  export RUNTIME_LIFECYCLE_VISIT_SPAN_ID
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  RUNTIME_LIFECYCLE_VISIT_STARTED_NS=$mono
  RUNTIME_LIFECYCLE_VISIT_STARTED_AT=$at
  export RUNTIME_LIFECYCLE_VISIT_STARTED_NS RUNTIME_LIFECYCLE_VISIT_STARTED_AT
  local -a fields=(visitReason string "$reason" cursorOrdinal integer "$ordinal")
  if [[ -n "$transition" ]]; then fields+=(transitionId string "$transition"); else fields+=(transitionId null null); fi
  if [[ -n "$stage_hash" ]]; then fields+=(stageEventHash string "$stage_hash"); else fields+=(stageEventHash null null); fi
  details=$(runtime_analytics_json_v2 "${fields[@]}") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 node_visit_started "$details" \
      "$FACTORY_LIFECYCLE_NODE_VISIT_ID:start" "$RUNTIME_LIFECYCLE_VISIT_SPAN_ID"
}

runtime_lifecycle_node_visit_finish_v2() {
  local status=$1 reason=$2 exit_kind=$3 transition=${4:-} stage_hash=${5:-}
  local at mono boot duration details fidelity=monotonic
  runtime_lifecycle_enabled_v2 || return 0
  unset FACTORY_LIFECYCLE_NODE_EXECUTION_ID FACTORY_LIFECYCLE_DISPATCH_ID
  unset FACTORY_LIFECYCLE_RUN_ID FACTORY_LIFECYCLE_EPOCH
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  if [[ -n "$RUNTIME_LIFECYCLE_VISIT_STARTED_NS" ]]; then
    duration=$(runtime_lifecycle_duration_ms_v2 "$RUNTIME_LIFECYCLE_VISIT_STARTED_NS" "$mono") || return
  else
    [[ -n "$RUNTIME_LIFECYCLE_VISIT_STARTED_AT" ]] || return 78
    duration=$(runtime_analytics_python_v2 wall-ms "$RUNTIME_LIFECYCLE_VISIT_STARTED_AT" "$at") || return
    fidelity=wall
  fi
  local -a fields=(
    status string "$status" reasonCode string "$reason" reasonTextSha256 null null
    durationMs integer "$duration" durationFidelity string "$fidelity" evidenceSha256 null null
    exitKind string "$exit_kind"
  )
  if [[ -n "$transition" ]]; then fields+=(transitionId string "$transition"); else fields+=(transitionId null null); fi
  if [[ -n "$stage_hash" ]]; then fields+=(stageEventHash string "$stage_hash"); else fields+=(stageEventHash null null); fi
  details=$(runtime_analytics_json_v2 "${fields[@]}") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 node_visit_finished "$details" \
      "$FACTORY_LIFECYCLE_NODE_VISIT_ID:finish" "$RUNTIME_LIFECYCLE_VISIT_SPAN_ID"
}

runtime_lifecycle_node_execution_begin_v2() {
  local executor=$1 retry_ordinal=$2 retry_before=$3 reason=${4:-initial}
  local at mono boot details
  runtime_lifecycle_enabled_v2 || return 0
  [[ "$retry_ordinal" =~ ^[0-9]+$ && "$retry_before" =~ ^[0-9]+$ ]] || return 2
  case "$reason" in initial|no_result|product_failure|manual_resume) ;; *) return 2 ;; esac
  FACTORY_LIFECYCLE_NODE_EXECUTION_ID=$(runtime_analytics_id_v2 ne \
    "$FACTORY_LIFECYCLE_NODE_VISIT_ID" "$retry_ordinal" "$reason") || return
  export FACTORY_LIFECYCLE_NODE_EXECUTION_ID
  unset FACTORY_LIFECYCLE_DISPATCH_ID FACTORY_LIFECYCLE_RUN_ID FACTORY_LIFECYCLE_EPOCH
  RUNTIME_LIFECYCLE_EXECUTION_SPAN_ID=$(runtime_analytics_id_v2 sp \
    "$FACTORY_LIFECYCLE_NODE_EXECUTION_ID" execution) || return
  export RUNTIME_LIFECYCLE_EXECUTION_SPAN_ID
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  RUNTIME_LIFECYCLE_EXECUTION_STARTED_NS=$mono
  export RUNTIME_LIFECYCLE_EXECUTION_STARTED_NS
  details=$(runtime_analytics_json_v2 \
    executionReason string "$reason" retryOrdinal integer "$retry_ordinal" \
    retryBudgetBefore integer "$retry_before" executorKind string "$executor") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 node_execution_started "$details" \
      "$FACTORY_LIFECYCLE_NODE_EXECUTION_ID:start" "$RUNTIME_LIFECYCLE_EXECUTION_SPAN_ID"
}

runtime_lifecycle_node_execution_finish_v2() {
  local status=$1 reason=$2 retry_after=$3 outcome=${4:-} outcome_source=${5:-none}
  local verdict_hash=${6:-} final_run=${7:-} at mono boot duration details
  runtime_lifecycle_enabled_v2 || return 0
  unset FACTORY_LIFECYCLE_DISPATCH_ID FACTORY_LIFECYCLE_RUN_ID FACTORY_LIFECYCLE_EPOCH
  [[ "$retry_after" =~ ^[0-9]+$ ]] || return 2
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  duration=$(runtime_lifecycle_duration_ms_v2 "$RUNTIME_LIFECYCLE_EXECUTION_STARTED_NS" "$mono") || return
  local -a fields=(
    status string "$status" reasonCode string "$reason" reasonTextSha256 null null
    durationMs integer "$duration" durationFidelity string monotonic evidenceSha256 null null
    retryBudgetAfter integer "$retry_after" productOutcomeSource string "$outcome_source"
  )
  if [[ -n "$outcome" ]]; then fields+=(productOutcome string "$outcome"); else fields+=(productOutcome null null); fi
  if [[ -n "$verdict_hash" ]]; then fields+=(productVerdictHash string "$verdict_hash"); else fields+=(productVerdictHash null null); fi
  if [[ -n "$final_run" ]]; then fields+=(finalRunId string "$final_run"); else fields+=(finalRunId null null); fi
  details=$(runtime_analytics_json_v2 "${fields[@]}") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 node_execution_finished "$details" \
      "$FACTORY_LIFECYCLE_NODE_EXECUTION_ID:finish" "$RUNTIME_LIFECYCLE_EXECUTION_SPAN_ID"
}

runtime_lifecycle_command_begin_v2() {
  local contract_hash=$1 at mono boot details
  runtime_lifecycle_enabled_v2 || return 0
  RUNTIME_LIFECYCLE_COMMAND_SPAN_ID=$(runtime_analytics_id_v2 sp \
    "$FACTORY_LIFECYCLE_NODE_EXECUTION_ID" command) || return
  export RUNTIME_LIFECYCLE_COMMAND_SPAN_ID
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  RUNTIME_LIFECYCLE_COMMAND_STARTED_NS=$mono
  export RUNTIME_LIFECYCLE_COMMAND_STARTED_NS
  details=$(runtime_analytics_json_v2 commandKind string profile_hook \
    commandContractSha256 string "$contract_hash") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 command_started "$details" \
      "$FACTORY_LIFECYCLE_NODE_EXECUTION_ID:command:start" "$RUNTIME_LIFECYCLE_COMMAND_SPAN_ID"
}

runtime_lifecycle_command_finish_v2() {
  local status=$1 reason=$2 exit_code=$3 verdict_hash=${4:-}
  local at mono boot duration details verdict_type=null
  runtime_lifecycle_enabled_v2 || return 0
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  duration=$(runtime_lifecycle_duration_ms_v2 "$RUNTIME_LIFECYCLE_COMMAND_STARTED_NS" "$mono") || return
  [[ -n "$verdict_hash" ]] && verdict_type=string
  details=$(runtime_analytics_json_v2 \
    status string "$status" reasonCode string "$reason" reasonTextSha256 null null \
    durationMs integer "$duration" durationFidelity string monotonic evidenceSha256 null null \
    exitCode integer "$exit_code" signal null null verdictSha256 "$verdict_type" "${verdict_hash:-null}") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 command_finished "$details" \
      "$FACTORY_LIFECYCLE_NODE_EXECUTION_ID:command:finish" "$RUNTIME_LIFECYCLE_COMMAND_SPAN_ID"
}

runtime_lifecycle_dispatch_begin_v2() {
  local source=$1 policy_hash=$2 candidate_count=$3 ordinal=${4:-0}
  local at mono boot details
  runtime_lifecycle_enabled_v2 || return 0
  [[ "$candidate_count" =~ ^[1-9][0-9]*$ && "$ordinal" =~ ^[0-9]+$ ]] || return 2
  case "$source" in
    task-stage|task|profile-stage|profile-project|manual-switch) ;;
    *) return 2 ;;
  esac
  [[ "$policy_hash" =~ ^[a-f0-9]{64}$ ]] || return 2
  FACTORY_LIFECYCLE_DISPATCH_ID=$(runtime_analytics_id_v2 d \
    "$FACTORY_LIFECYCLE_NODE_EXECUTION_ID" "$ordinal" "$source" "$policy_hash") || return
  export FACTORY_LIFECYCLE_DISPATCH_ID
  unset FACTORY_LIFECYCLE_RUN_ID FACTORY_LIFECYCLE_EPOCH
  RUNTIME_LIFECYCLE_DISPATCH_SPAN_ID=$(runtime_analytics_id_v2 sp \
    "$FACTORY_LIFECYCLE_DISPATCH_ID" dispatch) || return
  export RUNTIME_LIFECYCLE_DISPATCH_SPAN_ID
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  RUNTIME_LIFECYCLE_DISPATCH_STARTED_NS=$mono
  export RUNTIME_LIFECYCLE_DISPATCH_STARTED_NS
  details=$(runtime_analytics_json_v2 \
    policySource string "$source" policySha256 string "$policy_hash" \
    candidateCount integer "$candidate_count") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 dispatch_started "$details" \
      "$FACTORY_LIFECYCLE_DISPATCH_ID:start" "$RUNTIME_LIFECYCLE_DISPATCH_SPAN_ID"
}

runtime_lifecycle_dispatch_candidate_selected_v2() {
  local ordinal=$1 provider=$2 requested=$3 resolved=${4:-} effort=${5:-}
  local family=${6:-} source=$7 breaker=$8 preflight=$9 reason=${10}
  local details resolved_type=null effort_type=null family_type=null
  runtime_lifecycle_enabled_v2 || return 0
  [[ "$ordinal" =~ ^[0-9]+$ ]] || return 2

  requested=$(runtime_lifecycle_model_id_v2 "$requested") || return
  resolved=$(runtime_lifecycle_model_id_v2 "$resolved") || return

  [[ -n "$resolved" ]] && resolved_type=string
  [[ -n "$effort" ]] && effort_type=string
  [[ -n "$family" ]] && family_type=string
  details=$(runtime_analytics_json_v2 \
    candidateOrdinal integer "$ordinal" provider string "$provider" \
    requestedModel string "$requested" resolvedModel "$resolved_type" "${resolved:-null}" \
    effort "$effort_type" "${effort:-null}" family "$family_type" "${family:-null}" \
    policySource string "$source" breakerResult string "$breaker" \
    preflightResult string "$preflight" selectionReason string "$reason") || return
  unset FACTORY_LIFECYCLE_RUN_ID FACTORY_LIFECYCLE_EPOCH
  runtime_lifecycle_emit_v2 dispatch_candidate_selected "$details" \
    "$FACTORY_LIFECYCLE_DISPATCH_ID:selected:$ordinal:$provider:$resolved" -
}

runtime_lifecycle_dispatch_candidate_skipped_v2() {
  local ordinal=$1 provider=$2 requested=${3:-unknown} resolved=${4:-}
  local effort=${5:-} family=${6:-} source=$7 breaker=$8 preflight=$9 reason=${10}
  local evidence=${11:-} details resolved_type=null effort_type=null family_type=null evidence_type=null
  runtime_lifecycle_enabled_v2 || return 0
  [[ "$ordinal" =~ ^[0-9]+$ ]] || return 2

  requested=$(runtime_lifecycle_model_id_v2 "$requested") || return
  resolved=$(runtime_lifecycle_model_id_v2 "$resolved") || return

  [[ -n "$resolved" ]] && resolved_type=string
  [[ -n "$effort" ]] && effort_type=string
  [[ -n "$family" ]] && family_type=string
  [[ -n "$evidence" ]] && evidence_type=string
  details=$(runtime_analytics_json_v2 \
    candidateOrdinal integer "$ordinal" provider string "$provider" \
    requestedModel string "$requested" resolvedModel "$resolved_type" "${resolved:-null}" \
    effort "$effort_type" "${effort:-null}" family "$family_type" "${family:-null}" \
    policySource string "$source" breakerResult string "$breaker" \
    preflightResult string "$preflight" skipReason string "$reason" \
    evidenceSha256 "$evidence_type" "${evidence:-null}") || return
  unset FACTORY_LIFECYCLE_RUN_ID FACTORY_LIFECYCLE_EPOCH
  runtime_lifecycle_emit_v2 dispatch_candidate_skipped "$details" \
    "$FACTORY_LIFECYCLE_DISPATCH_ID:skipped:$ordinal:$provider:$reason" -
}

runtime_lifecycle_failover_selected_v2() {
  local from_run=$1 from_epoch=$2 from_provider=$3 to_provider=$4 reason=$5
  local scope=${6:-none} evidence=${7:-} details evidence_type=null
  runtime_lifecycle_enabled_v2 || return 0
  [[ -n "$evidence" ]] && evidence_type=string
  export FACTORY_LIFECYCLE_RUN_ID=$from_run FACTORY_LIFECYCLE_EPOCH=$from_epoch
  details=$(runtime_analytics_json_v2 \
    fromRunId string "$from_run" fromProvider string "$from_provider" \
    toProvider string "$to_provider" reasonCode string "$reason" \
    breakerScope string "$scope" evidenceSha256 "$evidence_type" "${evidence:-null}") || return
  runtime_lifecycle_emit_v2 failover_selected "$details" \
    "$FACTORY_LIFECYCLE_DISPATCH_ID:failover:$from_run:$to_provider" -
}

runtime_lifecycle_dispatch_finish_v2() {
  local status=$1 reason=$2 outcome=$3 selected_ordinal=${4:-} selected_run=${5:-}
  local at mono boot duration details ordinal_type=null run_type=null
  runtime_lifecycle_enabled_v2 || return 0
  [[ -n "$selected_ordinal" ]] && ordinal_type=integer
  [[ -n "$selected_run" ]] && run_type=string
  unset FACTORY_LIFECYCLE_RUN_ID FACTORY_LIFECYCLE_EPOCH
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  duration=$(runtime_lifecycle_duration_ms_v2 "$RUNTIME_LIFECYCLE_DISPATCH_STARTED_NS" "$mono") || return
  details=$(runtime_analytics_json_v2 \
    status string "$status" reasonCode string "$reason" reasonTextSha256 null null \
    durationMs integer "$duration" durationFidelity string monotonic evidenceSha256 null null \
    outcome string "$outcome" selectedCandidateOrdinal "$ordinal_type" "${selected_ordinal:-null}" \
    selectedRunId "$run_type" "${selected_run:-null}") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 dispatch_finished "$details" \
      "$FACTORY_LIFECYCLE_DISPATCH_ID:finish" "$RUNTIME_LIFECYCLE_DISPATCH_SPAN_ID" || return
  unset FACTORY_LIFECYCLE_DISPATCH_ID FACTORY_LIFECYCLE_RUN_ID FACTORY_LIFECYCLE_EPOCH
}

# Восстанавливает точный неизменяемый scope уже записанного события. Это нужно
# control-plane-процессам (ручной switch/gate/goto), не унаследовавшим shell-окружение
# foreground-оркестратора.
runtime_lifecycle_adopt_event_v2() {
  local event=$1 preserve_session=${2:-0} values current_session=${FACTORY_LIFECYCLE_SESSION_ID:-}
  local task attempt profile route route_hash session visit execution node run_key
  local dispatch run_id epoch span
  values=$(runtime_analytics_python_v2 event-context "$event") || return
  IFS=$'\t' read -r task attempt profile route route_hash session visit execution \
    node run_key dispatch run_id epoch span <<<"$values"
  [[ "$route" != - ]] || route=""
  [[ "$route_hash" != - ]] || route_hash=""
  [[ "$visit" != - ]] || visit=""
  [[ "$execution" != - ]] || execution=""
  [[ "$node" != - ]] || node=""
  [[ "$run_key" != - ]] || run_key=""
  [[ "$dispatch" != - ]] || dispatch=""
  [[ "$run_id" != - ]] || run_id=""
  [[ "$epoch" != - ]] || epoch=""
  [[ "$span" != - ]] || span=""
  [[ -n "$task" && -n "$attempt" && -n "$profile" && -n "$session" ]] || return 78
  if [[ "$preserve_session" == 1 && -n "$current_session" ]]; then
    session=$current_session
  fi
  runtime_lifecycle_set_context_v2 \
    "$task" "$attempt" "$profile" "$route" "$route_hash" "$session" >/dev/null || return
  export FACTORY_LIFECYCLE_NODE_VISIT_ID=$visit
  export FACTORY_LIFECYCLE_NODE_EXECUTION_ID=$execution
  export FACTORY_LIFECYCLE_NODE_ID=$node
  export FACTORY_LIFECYCLE_RUN_KEY=$run_key
  export FACTORY_LIFECYCLE_DISPATCH_ID=$dispatch
  export FACTORY_LIFECYCLE_RUN_ID=$run_id
  export FACTORY_LIFECYCLE_EPOCH=$epoch
  export FACTORY_LIFECYCLE_SPAN_ID=$span
}

runtime_lifecycle_active_attempt_v2() {
  local task=${1#[tT]} root lock_fd attempt rc
  root=$(attempt_state_v2_task_root "$task") || return
  _attempt_state_lock "$task" lock_fd || return
  # Публичный помощник resume намеренно превращает «нет активной попытки» в CAS-конфликт
  # (75). Вызывающим аналитику нужно отличать этот legacy/no-ledger случай от повреждённой
  # активной попытки, поэтому читаем проверенный указатель напрямую.
  attempt=$(_attempt_state_active_id_locked "$root" "$task")
  rc=$?
  _attempt_state_unlock "$lock_fd"
  (( rc == 0 )) || return "$rc"
  printf '%s\n' "$attempt"
}

runtime_lifecycle_find_run_v2() {
  local task=${1#[tT]} run_id=$2 epoch=$3 output=$4 attempt root ledger rc
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ && "$epoch" =~ ^[1-9][0-9]*$ ]] || return 2
  attempt=$(runtime_lifecycle_active_attempt_v2 "$task") || return
  root=$(factory_control_root) || return
  ledger=$(mktemp "$root/.runtime-lifecycle-read.XXXXXX") || return 1
  attempt_lifecycle_read_v2 "$task" "$attempt" >"$ledger"
  rc=$?
  if (( rc == 0 )); then
    runtime_analytics_python_v2 find-run "$ledger" "$run_id" "$epoch" >"$output"
    rc=$?
  fi
  rm -f -- "$ledger"
  return "$rc"
}

runtime_lifecycle_find_open_span_v2() {
  local started=$1 finished=$2 output=$3 node=${4:-} task attempt root ledger rc
  runtime_lifecycle_enabled_v2 || return 3
  task=${FACTORY_LIFECYCLE_TASK_ID#t}
  attempt=$FACTORY_LIFECYCLE_ATTEMPT_ID
  root=$(factory_control_root) || return
  ledger=$(mktemp "$root/.runtime-lifecycle-open.XXXXXX") || return 1
  attempt_lifecycle_read_v2 "$task" "$attempt" >"$ledger"
  rc=$?
  if (( rc == 0 )); then
    if [[ -n "$node" ]]; then
      runtime_analytics_python_v2 find-open-span \
        "$ledger" "$started" "$finished" "$node" >"$output"
    else
      runtime_analytics_python_v2 find-open-span \
        "$ledger" "$started" "$finished" >"$output"
    fi
    rc=$?
  fi
  rm -f -- "$ledger"
  return "$rc"
}

runtime_lifecycle_bind_run_v2() {
  local task=$1 run_id=$2 epoch=$3 root event rc
  root=$(factory_control_root) || return
  event=$(mktemp "$root/.runtime-lifecycle-run.XXXXXX") || return 1
  runtime_lifecycle_find_run_v2 "$task" "$run_id" "$epoch" "$event"
  rc=$?
  if (( rc == 0 )); then
    runtime_lifecycle_adopt_event_v2 "$event"
    rc=$?
  fi
  rm -f -- "$event"
  return "$rc"
}

runtime_lifecycle_reconcile_routing_v2() {
  local task=${1#[tT]} attempt=$2 root stage ledger plan record line rc=0
  local stage_hash transition stage_at action target target_type now mono boot details
  local saved_visit=${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}
  local saved_execution=${FACTORY_LIFECYCLE_NODE_EXECUTION_ID:-}
  local saved_node=${FACTORY_LIFECYCLE_NODE_ID:-}
  local saved_run_key=${FACTORY_LIFECYCLE_RUN_KEY:-}
  local saved_dispatch=${FACTORY_LIFECYCLE_DISPATCH_ID:-}
  local saved_run=${FACTORY_LIFECYCLE_RUN_ID:-}
  local saved_epoch=${FACTORY_LIFECYCLE_EPOCH:-}
  local saved_span=${FACTORY_LIFECYCLE_SPAN_ID:-}
  runtime_lifecycle_enabled_v2 || return 0
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ &&
     "$attempt" == "$FACTORY_LIFECYCLE_ATTEMPT_ID" &&
     -n "${FACTORY_LIFECYCLE_ROUTE_ID:-}" ]] || return 2
  declare -F attempt_stage_state_routing_transitions_v2 >/dev/null || return 78
  root=$(factory_control_root) || return
  stage=$(mktemp "$root/.runtime-stage-transitions.XXXXXX") || return 1
  ledger=$(mktemp "$root/.runtime-routing-ledger.XXXXXX") || {
    rm -f -- "$stage"; return 1;
  }
  plan=$(mktemp "$root/.runtime-routing-plan.XXXXXX") || {
    rm -f -- "$stage" "$ledger"; return 1;
  }
  record=$(mktemp "$root/.runtime-routing-record.XXXXXX") || {
    rm -f -- "$stage" "$ledger" "$plan"; return 1;
  }
  attempt_stage_state_routing_transitions_v2 "$task" "$attempt" >"$stage" || rc=$?
  (( rc != 0 )) || attempt_lifecycle_read_v2 "$task" "$attempt" >"$ledger" || rc=$?
  (( rc != 0 )) || runtime_analytics_python_v2 missing-routing-transitions \
    "$stage" "$ledger" >"$plan" || rc=$?
  while (( rc == 0 )); do
    line=""
    IFS= read -r line
    [[ -n "$line" ]] || break
    [[ -n "$line" ]] || continue
    printf '%s\n' "$line" >"$record" || { rc=1; break; }
    stage_hash=$(runtime_analytics_json_get_v2 "$record" stageEventHash) || { rc=$?; break; }
    transition=$(runtime_analytics_json_get_v2 "$record" transitionId) || { rc=$?; break; }
    stage_at=$(runtime_analytics_json_get_v2 "$record" stageAt) || { rc=$?; break; }
    action=$(runtime_analytics_json_get_v2 "$record" action) || { rc=$?; break; }
    target=$(runtime_analytics_json_get_v2 "$record" targetNodeId) || { rc=$?; break; }
    if [[ "$target" == null ]]; then target_type=null; else target_type=string; fi
    details=$(runtime_analytics_json_v2 \
      transitionId string "$transition" stageEventHash string "$stage_hash" \
      stageAt string "$stage_at" action string "$action" \
      targetNodeId "$target_type" "$target" reasonCode string crash_gap) || {
        rc=$?; break;
      }
    runtime_lifecycle_clear_entity_v2
    IFS=$'\t' read -r now mono boot < <(runtime_analytics_now_v2) || { rc=$?; break; }
    FACTORY_LIFECYCLE_EVENT_AT=$stage_at \
    FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
    FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    FACTORY_LIFECYCLE_CLOCK_FIDELITY=derived \
      runtime_lifecycle_emit_v2 routing_transition_reconciled "$details" \
        "$transition:reconciled" - || { rc=$?; break; }
  done <"$plan"
  export FACTORY_LIFECYCLE_NODE_VISIT_ID=$saved_visit
  export FACTORY_LIFECYCLE_NODE_EXECUTION_ID=$saved_execution
  export FACTORY_LIFECYCLE_NODE_ID=$saved_node
  export FACTORY_LIFECYCLE_RUN_KEY=$saved_run_key
  export FACTORY_LIFECYCLE_DISPATCH_ID=$saved_dispatch
  export FACTORY_LIFECYCLE_RUN_ID=$saved_run
  export FACTORY_LIFECYCLE_EPOCH=$saved_epoch
  export FACTORY_LIFECYCLE_SPAN_ID=$saved_span
  rm -f -- "$stage" "$ledger" "$plan" "$record"
  return "$rc"
}

RUNTIME_LIFECYCLE_USAGE_RECONCILED_HASH=""

runtime_lifecycle_reconcile_usage_v2() {
  local task=${1#[tT]} attempt=$2 capture_run=${3:-} root ledger plan record event line rc=0
  local run_id epoch document_hash details now mono boot event_hash
  local -a reconcile_args=()
  local saved_visit=${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}
  local saved_execution=${FACTORY_LIFECYCLE_NODE_EXECUTION_ID:-}
  local saved_node=${FACTORY_LIFECYCLE_NODE_ID:-}
  local saved_run_key=${FACTORY_LIFECYCLE_RUN_KEY:-}
  local saved_dispatch=${FACTORY_LIFECYCLE_DISPATCH_ID:-}
  local saved_run=${FACTORY_LIFECYCLE_RUN_ID:-}
  local saved_epoch=${FACTORY_LIFECYCLE_EPOCH:-}
  local saved_span=${FACTORY_LIFECYCLE_SPAN_ID:-}
  runtime_lifecycle_enabled_v2 || return 0
  [[ "$task" =~ ^[1-9][0-9]{0,18}$ &&
     "$attempt" == "$FACTORY_LIFECYCLE_ATTEMPT_ID" ]] || return 2
  RUNTIME_LIFECYCLE_USAGE_RECONCILED_HASH=""
  export RUNTIME_LIFECYCLE_USAGE_RECONCILED_HASH
  root=$(factory_control_root) || return
  ledger=$(mktemp "$root/.runtime-usage-ledger.XXXXXX") || return 1
  plan=$(mktemp "$root/.runtime-usage-plan.XXXXXX") || {
    rm -f -- "$ledger"; return 1;
  }
  record=$(mktemp "$root/.runtime-usage-record.XXXXXX") || {
    rm -f -- "$ledger" "$plan"; return 1;
  }
  event=$(mktemp "$root/.runtime-usage-finished.XXXXXX") || {
    rm -f -- "$ledger" "$plan" "$record"; return 1;
  }
  attempt_lifecycle_read_v2 "$task" "$attempt" >"$ledger" || rc=$?
  if (( rc == 0 )); then
    reconcile_args=(
      reconcile-plan "$root" "t$task" "$attempt" "$ledger"
    )
    [[ -z "$capture_run" ]] || reconcile_args+=("$capture_run")
    "${NODE_BIN:-node}" "$FACTORY_HOME/lib/runtime-usage.mjs" \
      "${reconcile_args[@]}" >"$plan" || rc=$?
  fi
  while (( rc == 0 )); do
    line=""
    IFS= read -r line
    [[ -n "$line" ]] || break
    [[ -n "$line" ]] || continue
    printf '%s\n' "$line" >"$record" || { rc=1; break; }
    run_id=$(runtime_analytics_json_get_v2 "$record" runId) || { rc=$?; break; }
    epoch=$(runtime_analytics_json_get_v2 "$record" epoch) || { rc=$?; break; }
    document_hash=$(runtime_analytics_json_get_v2 "$record" documentHash) || { rc=$?; break; }
    runtime_analytics_json_get_v2 "$record" runnerFinished >"$event" || { rc=$?; break; }
    details=$(runtime_analytics_json_get_v2 "$record" details) || { rc=$?; break; }
    runtime_lifecycle_adopt_event_v2 "$event" 1 || { rc=$?; break; }
    IFS=$'\t' read -r now mono boot < <(runtime_analytics_now_v2) || { rc=$?; break; }
    event_hash=$(
      FACTORY_LIFECYCLE_EVENT_AT=$now \
      FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
      FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
      FACTORY_LIFECYCLE_CLOCK_FIDELITY=derived \
        runtime_lifecycle_emit_v2 runner_usage_reconciled "$details" \
          "$run_id:$epoch:usage-reconciled:$document_hash" -
    ) || { rc=$?; break; }
    if [[ -n "$capture_run" && "$run_id" == "$capture_run" ]]; then
      RUNTIME_LIFECYCLE_USAGE_RECONCILED_HASH=$event_hash
      export RUNTIME_LIFECYCLE_USAGE_RECONCILED_HASH
    fi
  done <"$plan"
  export FACTORY_LIFECYCLE_NODE_VISIT_ID=$saved_visit
  export FACTORY_LIFECYCLE_NODE_EXECUTION_ID=$saved_execution
  export FACTORY_LIFECYCLE_NODE_ID=$saved_node
  export FACTORY_LIFECYCLE_RUN_KEY=$saved_run_key
  export FACTORY_LIFECYCLE_DISPATCH_ID=$saved_dispatch
  export FACTORY_LIFECYCLE_RUN_ID=$saved_run
  export FACTORY_LIFECYCLE_EPOCH=$saved_epoch
  export FACTORY_LIFECYCLE_SPAN_ID=$saved_span
  rm -f -- "$ledger" "$plan" "$record" "$event"
  return "$rc"
}

runtime_lifecycle_restore_open_visit_v2() {
  local node=$1 root event rc started_at
  root=$(factory_control_root) || return
  event=$(mktemp "$root/.runtime-lifecycle-visit.XXXXXX") || return 1
  runtime_lifecycle_find_open_span_v2 \
    node_visit_started node_visit_finished "$event" "$node"
  rc=$?
  if (( rc == 0 )); then
    runtime_lifecycle_adopt_event_v2 "$event" 1 || rc=$?
  fi
  if (( rc == 0 )); then
    started_at=$(runtime_analytics_json_get_v2 "$event" at) || rc=$?
    RUNTIME_LIFECYCLE_VISIT_STARTED_AT=$started_at
    RUNTIME_LIFECYCLE_VISIT_STARTED_NS=""
    RUNTIME_LIFECYCLE_VISIT_SPAN_ID=${FACTORY_LIFECYCLE_SPAN_ID:-}
    export RUNTIME_LIFECYCLE_VISIT_STARTED_AT RUNTIME_LIFECYCLE_VISIT_STARTED_NS
    export RUNTIME_LIFECYCLE_VISIT_SPAN_ID
  fi
  rm -f -- "$event"
  return "$rc"
}

runtime_lifecycle_sandbox_begin_v2() {
  local mode=$1 workspace_hash=$2 policy_hash=$3 details
  runtime_lifecycle_enabled_v2 || return 0
  details=$(runtime_analytics_json_v2 \
    sandboxMode string "$mode" workspaceIdentitySha256 string "$workspace_hash" \
    policySha256 string "$policy_hash") || return
  runtime_lifecycle_attempt_span_begin_v2 \
    sandbox_started "sandbox:$workspace_hash" "$details"
}

runtime_lifecycle_sandbox_finish_v2() {
  local workspace_hash=$1 status=$2 reason=$3 evidence=${4:-}
  runtime_lifecycle_attempt_span_finish_v2 \
    sandbox_finished "sandbox:$workspace_hash" "$status" "$reason" "$evidence"
}

RUNTIME_LIFECYCLE_CLEANUP_STARTED_NS=""
RUNTIME_LIFECYCLE_CLEANUP_SPAN_ID=""
RUNTIME_LIFECYCLE_CLEANUP_KEY=""
RUNTIME_LIFECYCLE_CLEANUP_SAVED_VISIT=""
RUNTIME_LIFECYCLE_CLEANUP_SAVED_EXECUTION=""
RUNTIME_LIFECYCLE_CLEANUP_SAVED_NODE=""
RUNTIME_LIFECYCLE_CLEANUP_SAVED_RUN_KEY=""
RUNTIME_LIFECYCLE_CLEANUP_SAVED_DISPATCH=""
RUNTIME_LIFECYCLE_CLEANUP_SAVED_RUN=""
RUNTIME_LIFECYCLE_CLEANUP_SAVED_EPOCH=""
RUNTIME_LIFECYCLE_CLEANUP_SAVED_SPAN=""

runtime_lifecycle_cleanup_restore_scope_v2() {
  export FACTORY_LIFECYCLE_NODE_VISIT_ID=$RUNTIME_LIFECYCLE_CLEANUP_SAVED_VISIT
  export FACTORY_LIFECYCLE_NODE_EXECUTION_ID=$RUNTIME_LIFECYCLE_CLEANUP_SAVED_EXECUTION
  export FACTORY_LIFECYCLE_NODE_ID=$RUNTIME_LIFECYCLE_CLEANUP_SAVED_NODE
  export FACTORY_LIFECYCLE_RUN_KEY=$RUNTIME_LIFECYCLE_CLEANUP_SAVED_RUN_KEY
  export FACTORY_LIFECYCLE_DISPATCH_ID=$RUNTIME_LIFECYCLE_CLEANUP_SAVED_DISPATCH
  export FACTORY_LIFECYCLE_RUN_ID=$RUNTIME_LIFECYCLE_CLEANUP_SAVED_RUN
  export FACTORY_LIFECYCLE_EPOCH=$RUNTIME_LIFECYCLE_CLEANUP_SAVED_EPOCH
  export FACTORY_LIFECYCLE_SPAN_ID=$RUNTIME_LIFECYCLE_CLEANUP_SAVED_SPAN
}

runtime_lifecycle_cleanup_begin_v2() {
  local kind=$1 target_hash=$2 at mono boot details rc
  runtime_lifecycle_enabled_v2 || return 0
  RUNTIME_LIFECYCLE_CLEANUP_SAVED_VISIT=${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}
  RUNTIME_LIFECYCLE_CLEANUP_SAVED_EXECUTION=${FACTORY_LIFECYCLE_NODE_EXECUTION_ID:-}
  RUNTIME_LIFECYCLE_CLEANUP_SAVED_NODE=${FACTORY_LIFECYCLE_NODE_ID:-}
  RUNTIME_LIFECYCLE_CLEANUP_SAVED_RUN_KEY=${FACTORY_LIFECYCLE_RUN_KEY:-}
  RUNTIME_LIFECYCLE_CLEANUP_SAVED_DISPATCH=${FACTORY_LIFECYCLE_DISPATCH_ID:-}
  RUNTIME_LIFECYCLE_CLEANUP_SAVED_RUN=${FACTORY_LIFECYCLE_RUN_ID:-}
  RUNTIME_LIFECYCLE_CLEANUP_SAVED_EPOCH=${FACTORY_LIFECYCLE_EPOCH:-}
  RUNTIME_LIFECYCLE_CLEANUP_SAVED_SPAN=${FACTORY_LIFECYCLE_SPAN_ID:-}
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  RUNTIME_LIFECYCLE_CLEANUP_KEY="$kind:$target_hash:$mono"
  RUNTIME_LIFECYCLE_CLEANUP_SPAN_ID=$(runtime_analytics_id_v2 sp \
    "$FACTORY_LIFECYCLE_SESSION_ID" "$RUNTIME_LIFECYCLE_CLEANUP_KEY") || return
  RUNTIME_LIFECYCLE_CLEANUP_STARTED_NS=$mono
  export RUNTIME_LIFECYCLE_CLEANUP_KEY RUNTIME_LIFECYCLE_CLEANUP_SPAN_ID
  export RUNTIME_LIFECYCLE_CLEANUP_STARTED_NS
  details=$(runtime_analytics_json_v2 \
    cleanupKind string "$kind" targetIdentitySha256 string "$target_hash") || return
  runtime_lifecycle_clear_entity_v2
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 cleanup_started "$details" \
      "$RUNTIME_LIFECYCLE_CLEANUP_KEY:start" "$RUNTIME_LIFECYCLE_CLEANUP_SPAN_ID"
  rc=$?
  if (( rc != 0 )); then
    runtime_lifecycle_cleanup_restore_scope_v2
  fi
  return "$rc"
}

runtime_lifecycle_cleanup_finish_v2() {
  local kind=$1 status=$2 reason=$3 released=$4 retained=$5 evidence=${6:-}
  local at mono boot duration details evidence_type=null rc
  runtime_lifecycle_enabled_v2 || return 0
  [[ "$released" =~ ^[0-9]+$ && "$retained" =~ ^[0-9]+$ &&
     -n "$RUNTIME_LIFECYCLE_CLEANUP_STARTED_NS" ]] || return 2
  [[ -n "$evidence" ]] && evidence_type=string
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  duration=$(runtime_lifecycle_duration_ms_v2 \
    "$RUNTIME_LIFECYCLE_CLEANUP_STARTED_NS" "$mono") || return
  details=$(runtime_analytics_json_v2 \
    status string "$status" reasonCode string "$reason" reasonTextSha256 null null \
    durationMs integer "$duration" durationFidelity string monotonic \
    evidenceSha256 "$evidence_type" "${evidence:-null}" cleanupKind string "$kind" \
    releasedTargetCount integer "$released" retainedTargetCount integer "$retained") || return
  runtime_lifecycle_clear_entity_v2
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 cleanup_finished "$details" \
      "$RUNTIME_LIFECYCLE_CLEANUP_KEY:finish" "$RUNTIME_LIFECYCLE_CLEANUP_SPAN_ID"
  rc=$?
  runtime_lifecycle_cleanup_restore_scope_v2
  return "$rc"
}

runtime_lifecycle_shared_lease_released_v2() {
  local resource=$1 result=${2:-released} evidence=${3:-} kind identity details
  local evidence_type=null
  runtime_lifecycle_enabled_v2 || return 0
  kind=${resource%%:*}
  case "$kind" in profile|workspace|stand|gpu) ;; *) return 2 ;; esac
  identity=$(runtime_analytics_hash_string_v2 "$resource") || return
  [[ -n "$evidence" ]] && evidence_type=string
  runtime_lifecycle_clear_entity_v2
  details=$(runtime_analytics_json_v2 \
    leaseKind string "$kind" leaseIdentitySha256 string "$identity" \
    result string "$result" evidenceSha256 "$evidence_type" "${evidence:-null}") || return
  runtime_lifecycle_emit_v2 shared_lease_released "$details" \
    "$FACTORY_LIFECYCLE_ATTEMPT_ID:lease:$identity:$result" -
}

runtime_lifecycle_switch_event_v2() {
  local kind=$1 request_id=$2 source_run=$3 source_epoch=$4 target=$5 record_hash=$6
  local evidence=${7:-} reason=${8:-} details
  local evidence_type=null
  runtime_lifecycle_enabled_v2 || return 0
  export FACTORY_LIFECYCLE_RUN_ID=$source_run FACTORY_LIFECYCLE_EPOCH=$source_epoch
  case "$kind" in
    runner_switch_requested)
      details=$(runtime_analytics_json_v2 \
        requestId string "$request_id" sourceRunId string "$source_run" \
        sourceEpoch integer "$source_epoch" targetProvider string "$target" \
        requestRecordSha256 string "$record_hash") || return
      ;;
    runner_switch_consumed)
      [[ -n "$evidence" ]] || return 2
      details=$(runtime_analytics_json_v2 \
        requestId string "$request_id" sourceRunId string "$source_run" \
        sourceEpoch integer "$source_epoch" targetProvider string "$target" \
        requestRecordSha256 string "$record_hash" \
        consumeEvidenceSha256 string "$evidence") || return
      ;;
    runner_switch_rejected)
      [[ -n "$evidence" ]] && evidence_type=string
      details=$(runtime_analytics_json_v2 \
        requestId string "$request_id" sourceRunId string "$source_run" \
        sourceEpoch integer "$source_epoch" targetProvider string "$target" \
        requestRecordSha256 string "$record_hash" reasonCode string "$reason" \
        evidenceSha256 "$evidence_type" "${evidence:-null}") || return
      ;;
    *) return 2 ;;
  esac
  runtime_lifecycle_emit_v2 "$kind" "$details" \
    "$source_run:$source_epoch:switch:$request_id:$kind" -
}

runtime_lifecycle_gate_wait_begin_v2() {
  local gate=$1 revision=$2 stage_hash=$3 at mono boot details
  runtime_lifecycle_enabled_v2 || return 0
  [[ -n "${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}" ]] || return 78
  RUNTIME_LIFECYCLE_GATE_SPAN_ID=$(runtime_analytics_id_v2 sp \
    "$FACTORY_LIFECYCLE_NODE_VISIT_ID" gate-wait) || return
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  RUNTIME_LIFECYCLE_GATE_STARTED_AT=$at
  export RUNTIME_LIFECYCLE_GATE_SPAN_ID RUNTIME_LIFECYCLE_GATE_STARTED_AT
  details=$(runtime_analytics_json_v2 gateKey string "$gate" \
    cursorRevision integer "$revision" stageEventHash string "$stage_hash") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 gate_wait_started "$details" \
      "$FACTORY_LIFECYCLE_NODE_VISIT_ID:gate-wait:start" "$RUNTIME_LIFECYCLE_GATE_SPAN_ID"
}

runtime_lifecycle_restore_open_gate_v2() {
  local node=$1 root event rc
  root=$(factory_control_root) || return
  event=$(mktemp "$root/.runtime-lifecycle-gate.XXXXXX") || return 1
  runtime_lifecycle_find_open_span_v2 gate_wait_started gate_decided "$event" "$node"
  rc=$?
  if (( rc == 0 )); then
    RUNTIME_LIFECYCLE_GATE_SPAN_ID=$(runtime_analytics_json_get_v2 "$event" spanId) || rc=$?
    RUNTIME_LIFECYCLE_GATE_STARTED_AT=$(runtime_analytics_json_get_v2 "$event" at) || rc=$?
    export RUNTIME_LIFECYCLE_GATE_SPAN_ID RUNTIME_LIFECYCLE_GATE_STARTED_AT
  fi
  rm -f -- "$event"
  return "$rc"
}

runtime_lifecycle_gate_decided_v2() {
  local gate=$1 decision=$2 decision_hash=$3 feedback_hash=${4:-}
  local transition=$5 stage_hash=$6 at mono boot duration details feedback_type=null
  runtime_lifecycle_enabled_v2 || return 0
  [[ -n "${RUNTIME_LIFECYCLE_GATE_STARTED_AT:-}" &&
     -n "${RUNTIME_LIFECYCLE_GATE_SPAN_ID:-}" ]] || return 78
  [[ -n "$feedback_hash" ]] && feedback_type=string
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  duration=$(runtime_analytics_python_v2 wall-ms "$RUNTIME_LIFECYCLE_GATE_STARTED_AT" "$at") || return
  details=$(runtime_analytics_json_v2 \
    status string succeeded reasonCode string normal reasonTextSha256 null null \
    durationMs integer "$duration" durationFidelity string wall evidenceSha256 null null \
    gateKey string "$gate" decision string "$decision" \
    decisionRecordSha256 string "$decision_hash" \
    feedbackSha256 "$feedback_type" "${feedback_hash:-null}" \
    transitionId string "$transition" stageEventHash string "$stage_hash") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 gate_decided "$details" \
      "$FACTORY_LIFECYCLE_NODE_VISIT_ID:gate-wait:finish:$stage_hash" \
      "$RUNTIME_LIFECYCLE_GATE_SPAN_ID"
}

# Вмешательство человека связывается с визитом, на котором возникла остановка.
# Отсутствие визита — отказ контракта с видимой причиной, без записи события lifecycle.
runtime_lifecycle_human_begin_v2() {
  local reason=$1 evidence=${2:-} at mono boot details evidence_type=null
  runtime_lifecycle_enabled_v2 || return 0
  if [[ -z "${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}" ]]; then
    if declare -F v2_log >/dev/null; then
      v2_log "lifecycle: вмешательство человека не открыто — нет визита узла (причина: $reason)"
    else
      printf 'lifecycle: вмешательство человека не открыто — нет визита узла (причина: %s)\n' \
        "$reason" >&2
    fi
    return 78
  fi
  [[ -n "$evidence" ]] && evidence_type=string
  RUNTIME_LIFECYCLE_HUMAN_SPAN_ID=$(runtime_analytics_id_v2 sp \
    "$FACTORY_LIFECYCLE_NODE_VISIT_ID" human-intervention) || return
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  RUNTIME_LIFECYCLE_HUMAN_STARTED_AT=$at
  export RUNTIME_LIFECYCLE_HUMAN_SPAN_ID RUNTIME_LIFECYCLE_HUMAN_STARTED_AT
  details=$(runtime_analytics_json_v2 reasonCode string "$reason" \
    evidenceSha256 "$evidence_type" "${evidence:-null}") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 human_intervention_started "$details" \
      "$FACTORY_LIFECYCLE_NODE_VISIT_ID:human:start" "$RUNTIME_LIFECYCLE_HUMAN_SPAN_ID"
}

# Закрытие вопроса использует историческую связь с визитом только для нового события.
# Контекст вызывающего процесса сохраняется: связанный визит уже мог завершиться.
runtime_lifecycle_resolve_open_human_v2() {
  local event_hash rc
  event_hash=$(_runtime_lifecycle_resolve_open_human_event_v2 "$@")
  rc=$?
  (( rc == 0 )) || return "$rc"
  if [[ -n "$event_hash" ]]; then
    RUNTIME_LIFECYCLE_LAST_EVENT_HASH=$event_hash
    export RUNTIME_LIFECYCLE_LAST_EVENT_HASH
    printf '%s\n' "$event_hash"
  fi
  return 0
}

# Изолированный вызов восстанавливает identity вопроса, сохраняя текущую сессию писателя.
# Полный reader и append продолжают проверять журнал; отсутствие вопроса идемпотентно.
_runtime_lifecycle_resolve_open_human_event_v2() {
  local resolution=$1 resolution_hash=$2 root event rc started_at span at mono boot duration details
  runtime_lifecycle_enabled_v2 || return 0
  root=$(factory_control_root) || return
  event=$(mktemp "$root/.runtime-lifecycle-human.XXXXXX") || return 1
  runtime_lifecycle_find_open_span_v2 \
    human_intervention_started human_intervention_resolved "$event"
  rc=$?
  if (( rc == 3 )); then
    rm -f -- "$event"
    return 0
  fi
  if (( rc == 0 )); then
    runtime_lifecycle_adopt_event_v2 "$event" 1 || rc=$?
  fi
  if (( rc == 0 )); then
    started_at=$(runtime_analytics_json_get_v2 "$event" at) || rc=$?
    span=$(runtime_analytics_json_get_v2 "$event" spanId) || rc=$?
  fi
  rm -f -- "$event"
  (( rc == 0 )) || return "$rc"
  IFS=$'\t' read -r at mono boot < <(runtime_analytics_now_v2) || return
  duration=$(runtime_analytics_python_v2 wall-ms "$started_at" "$at") || return
  details=$(runtime_analytics_json_v2 \
    status string succeeded reasonCode string normal reasonTextSha256 null null \
    durationMs integer "$duration" durationFidelity string wall evidenceSha256 null null \
    resolutionCode string "$resolution" resolutionEvidenceSha256 string "$resolution_hash") || return
  FACTORY_LIFECYCLE_EVENT_AT=$at FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$mono \
  FACTORY_LIFECYCLE_EVENT_BOOT_ID=$boot \
    runtime_lifecycle_emit_v2 human_intervention_resolved "$details" \
      "$FACTORY_LIFECYCLE_NODE_VISIT_ID:human:finish:$resolution" "$span"
}
