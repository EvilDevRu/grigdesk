#!/usr/bin/env bash

source "${FACTORY_HOME:?}/lib/attempt-stage-state.sh"

# Экспорт берёт task lock ровно один раз для двух источников и их идентификаторов.
# Sealed attempt доступна для чтения; ни профиль, ни sandbox, ни модель не запускаются.
attempt_findings_export_v2() {
  local task=$1 attempt=$2 profile=$3 mode=${4:-json} target=${5:-}
  local lock_fd ledger rc
  task=$(_attempt_state_task_id "$task") || return
  attempt=$(_attempt_state_attempt_id "$attempt") || return
  [[ "$mode" == json || "$mode" == markdown || "$mode" == write ]] || return 2
  _attempt_state_lock "$task" lock_fd || return
  _attempt_stage_state_load_locked "$task" "$attempt" "" 1
  rc=$?
  if (( rc == 0 )) && [[ "$ASTAGE_PROFILE" != "$profile" ||
        "$ASTAGE_ROUTES_DIR" != "${ROUTES_DIR:-$ASTAGE_ROUTES_DIR}" ]]; then
    rc=75
  fi
  if (( rc == 0 )); then
    ledger=$(mktemp "$ASTAGE_ATTEMPT_DIR/.export-findings.XXXXXX") || rc=1
  fi
  if (( rc == 0 )); then
    _attempt_stage_state_findings_locked "$task" "$attempt" >"$ledger"
    rc=$?
  fi
  if (( rc == 0 )); then
    local -a target_args=()
    [[ "$mode" != write ]] || target_args=("$target")
    python3 "$FACTORY_HOME/lib/findings_export.py" "$ASTAGE_ATTEMPT_DIR" \
      "$task" "$profile" "$attempt" "$mode" "${target_args[@]}" <"$ledger"
    rc=$?
  fi
  [[ -z "${ledger:-}" ]] || rm -f -- "$ledger"
  _attempt_state_unlock "$lock_fd"
  return "$rc"
}
