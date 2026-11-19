#!/usr/bin/env bash
set -uo pipefail

# Родитель сохраняет оба lock. Этот процесс только читает закреплённую попытку.
control=$1 task=$2 attempt=$3 profile=$4 mode=$5 profile_file=$6 scratch=$7
shift 7
expected_stage=${1:-}
export FACTORY_CONTROL_ROOT="$control"
source "$FACTORY_HOME/lib/attempt-state.sh"
source "$FACTORY_HOME/lib/instrumentation-transaction.sh"
root=$(_attempt_state_v2_task_path "$control" "$task") || exit 78
pins=$(_attempt_state_resume_locked "$root" "$task" "$attempt" reader "$scratch") || exit $?
[[ $(jq -er .profile <<<"$pins") == "$profile" ]] || exit 78

tx_root="$control/transactions/t$task"
if [[ "$mode" != stop-cleanup && ( -e "$tx_root" || -L "$tx_root" ) ]]; then
  python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" requires-stop "$tx_root" "$task" "$attempt"
  rc=$?
  if (( rc == 75 )); then
    printf '%s\n' 'FACTORY_ERROR=release_task_cleanup_required' >&2
  fi
  (( rc == 0 )) || exit "$rc"
fi

if [[ "$mode" =~ ^(gate|goto|abandon|bootstrap-answer)$ ]]; then
  python3 "$FACTORY_HOME/lib/darwin-profile-channel.py" check "$control" "$task" "$attempt" "$profile_file" \
    "$FACTORY_DARWIN_PROCESS_HELPER"
  rc=$?
  if (( rc == 75 )); then
    printf '%s\n' 'FACTORY_ERROR=release_task_cleanup_required' >&2
  fi
  (( rc == 0 )) || exit "$rc"
fi
if [[ "$mode" =~ ^(gate|goto|abandon)$ ]]; then
  record=$(_instrumentation_tx_finalization_read "$task" "$attempt")
  rc=$?
  if (( rc == 0 )); then
    if [[ $(jq -er .phase <<<"$record") != synced ]]; then
      printf '%s\n' 'FACTORY_ERROR=release_task_cleanup_required' >&2
      exit 75
    fi
  elif (( rc != 3 )); then
    exit "$rc"
  fi
fi
if [[ ( -n "$expected_stage" && "$mode" =~ ^(gate|goto)$ ) ||
      ( "$mode" == gate && "${FACTORY_RUNTIME_CONTEXT_REQUIRED:-0}" == 1 ) ]]; then
  source "$FACTORY_HOME/lib/attempt-stage-state.sh"
  _attempt_stage_state_load_locked "$task" "$attempt" '' 0 "$scratch" || exit $?
  stage=$(_attempt_stage_state_validate_locked "$task" "$attempt" "$scratch") || exit $?
  if [[ -n "$expected_stage" ]] &&
     ! jq -e --arg stage "$expected_stage" '"\(.eventSequence):\(.headEventHash)" == $stage' <<<"$stage" >/dev/null; then
    printf '%s\n' 'FACTORY_ERROR=stale_stage' >&2
    exit 75
  fi
  if [[ "$mode" == gate ]] &&
     ! jq -e --arg node "${2:-}" '.currentNode == $node and (.state == "ready" or .state == "paused")' \
       <<<"$stage" >/dev/null; then
    printf '%s\n' 'FACTORY_ERROR=stale_stage' >&2
    exit 75
  fi
fi
if [[ "$mode" == bootstrap-answer ]]; then
  source "$FACTORY_HOME/lib/attempt-stage-state.sh"
  _attempt_stage_state_load_locked "$task" "$attempt" '' 0 "$scratch" || exit $?
  [[ "$ASTAGE_ROUTES_DIR" == "$5" ]] || exit 75
  python3 "$FACTORY_HOME/lib/bootstrap_journal.py" check-answer "$ASTAGE_ATTEMPT_DIR" \
    "$task" "$attempt" "$ASTAGE_PROFILE" "$ASTAGE_CATALOG_HASH" "$ASTAGE_ROUTE" "$ASTAGE_ROUTE_HASH" \
    "$ASTAGE_ROUTES_DIR" "$2" "$3" "$4" >/dev/null || exit $?
fi
printf '%s\n' "$pins"
