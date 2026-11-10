#!/usr/bin/env bash

# Проверяет origin до любой восстановительной записи runtime/lifecycle.
# Это только host read: legacy receipt с origin=null допустим лишь без lifecycle history.
_route_v2_pending_origin_check() {
  local task=$1 attempt=$2 pending="$ROUTE_V2_ATTEMPT_DIR/pending-transition.json"
  local temp origin_rc ledger_rc rc=78
  temp=$(mktemp -d "$(factory_control_root)/.pending-origin-check.XXXXXX") || return 74
  PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" has-origin "$pending"
  origin_rc=$?
  if (( origin_rc != 0 && origin_rc != 3 )); then
    rm -rf -- "$temp"
    return "$origin_rc"
  fi
  attempt_lifecycle_read_v2 "$task" "$attempt" >"$temp/ledger"
  ledger_rc=$?
  if (( origin_rc == 0 && ledger_rc == 0 )); then
    PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" origin "$pending" "$temp/ledger" >"$temp/origin"
    rc=$?
  elif (( origin_rc == 3 && ledger_rc == 3 )); then
    rc=0
  elif (( origin_rc == 3 && ledger_rc == 0 )) && [[ ! -s "$temp/ledger" ]]; then
    rc=0
  elif (( ledger_rc != 0 && ledger_rc != 3 )); then
    rc=$ledger_rc
  fi
  rm -rf -- "$temp"
  return "$rc"
}

# Читает exact accepted stop без исходников: ledger уже принял результат.
# Код 3 означает отсутствие такого pending; ошибка схемы/истории не подавляется.
_route_v2_pending_wait_probe() {
  local task=$1 attempt=$2 pending="$ROUTE_V2_ATTEMPT_DIR/pending-transition.json" temp rc origin_rc ledger_rc
  [[ -e "$pending" || -L "$pending" ]] || return 3
  temp=$(mktemp -d "$(factory_control_root)/.pending-probe.XXXXXX") || return 74
  attempt_stage_state_read_v2 "$task" "$attempt" >"$temp/state"
  rc=$?
  if (( rc == 0 )); then
    attempt_stage_state_latest_event_v2 "$task" "$attempt" >"$temp/event"
    rc=$?
  fi
  if (( rc == 0 )); then
    PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" probe-wait \
      "$pending" "$temp/state" "$temp/event"
    rc=$?
  fi
  if (( rc == 0 )); then
    _route_v2_pending_origin_check "$task" "$attempt" || rc=$?
  fi
  rm -rf -- "$temp"
  return "$rc"
}

# Привязывает только исходный exact visit, сохраняя сессию текущего писателя.
# Полный lifecycle reader предшествует выборке; чужой живой visit менять запрещено.
_route_v2_pending_adopt_origin() {
  local task=$1 attempt=$2 pending=$3 temp rc source_visit source_node source_key
  if ! runtime_lifecycle_enabled_v2; then
    PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" has-origin "$pending"
    rc=$?
    (( rc == 3 )) && return 0
    (( rc != 0 )) || return 78
    return "$rc"
  fi
  temp=$(mktemp -d "$(factory_control_root)/.pending-origin.XXXXXX") || return 74
  attempt_lifecycle_read_v2 "$task" "$attempt" >"$temp/ledger"
  rc=$?
  if (( rc == 0 )); then
    PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" origin \
      "$pending" "$temp/ledger" >"$temp/event"
    rc=$?
  fi
  if (( rc == 0 )); then
    source_visit=$(runtime_analytics_json_get_v2 "$temp/event" nodeVisitId) || rc=$?
    source_node=$(runtime_analytics_json_get_v2 "$temp/event" nodeId) || rc=$?
    source_key=$(runtime_analytics_json_get_v2 "$temp/event" runKey) || rc=$?
  fi
  if (( rc == 0 )) && [[ -n "${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}" ]]; then
    [[ "$FACTORY_LIFECYCLE_NODE_VISIT_ID" == "$source_visit" &&
       "${FACTORY_LIFECYCLE_NODE_ID:-}" == "$source_node" &&
       "${FACTORY_LIFECYCLE_RUN_KEY:-}" == "$source_key" ]] || rc=78
  elif (( rc == 0 )); then
    runtime_lifecycle_adopt_event_v2 "$temp/event" 1 || rc=$?
  fi
  rm -rf -- "$temp"
  return "$rc"
}

# Погашает accepted human stop только после durable human projection и UI.
# Factory вызывает ack после begin-once; отсутствие подтверждения оставляет receipt.
_route_v2_pending_ack_stop() {
  local task=$1 attempt=$2 pending="$ROUTE_V2_ATTEMPT_DIR/pending-transition.json"
  local temp state stop reason hash rc
  [[ -e "$pending" || -L "$pending" ]] || return 0
  _route_v2_pending_wait_probe "$task" "$attempt"
  rc=$?
  (( rc != 3 )) || return 78
  (( rc == 0 )) || return "$rc"
  _route_v2_pending_adopt_origin "$task" "$attempt" "$pending" || return
  temp=$(mktemp -d "$(factory_control_root)/.pending-ack.XXXXXX") || return 74
  attempt_stage_state_read_v2 "$task" "$attempt" >"$temp/state"
  rc=$?
  if (( rc == 0 )); then
    stop=$(runtime_analytics_json_get_v2 "$temp/state" stop) || rc=$?
    hash=$(runtime_analytics_json_get_v2 "$temp/state" headEventHash) || rc=$?
    reason=$(runtime_lifecycle_stop_reason_v2 "$stop") || rc=$?
  fi
  if (( rc == 0 )) && runtime_lifecycle_enabled_v2; then
    runtime_lifecycle_human_lookup_v2 "$reason" "$hash" "$temp/human"
    rc=$?
    (( rc != 3 )) || rc=78
  fi
  if (( rc == 0 )); then
    PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" remove "$pending" || rc=$?
  fi
  rm -rf -- "$temp"
  return "$rc"
}

# Продвигает только сохранённый хостом исход после postflight-проверок.
# Режимы: 0 — только что выполненный узел, 1 — replay, 2 — только проекция accepted stop.
_route_v2_pending_drive() {
  local task=$1 attempt=$2 replay=$3
  local pending="$ROUTE_V2_ATTEMPT_DIR/pending-transition.json" temp state event argv_file tree=''
  local status rc=0 commits=0 last_rc=74 stop cursor_state
  local -a args=()
  [[ "$replay" =~ ^[012]$ ]] || return 78
  [[ -e "$pending" || -L "$pending" ]] || return 3
  temp=$(mktemp -d "$(factory_control_root)/.pending-drive.XXXXXX") || return 74
  state="$temp/state.json"
  event="$temp/event.json"
  argv_file="$temp/argv"
  PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" emit "$pending" >"$argv_file" || {
    rc=$?
    rm -rf -- "$temp"
    return "$rc"
  }
  mapfile -d '' -t args <"$argv_file"
  if [[ ${#args[@]} != 13 || "${args[0]}" != "$task" || "${args[1]}" != "$attempt" ]]; then
    rm -rf -- "$temp"
    return 78
  fi
  while true; do
    attempt_stage_state_reconcile_pending_v2 "$task" "$attempt" || { rc=$?; break; }
    attempt_stage_state_read_v2 "$task" "$attempt" >"$state" || { rc=$?; break; }
    attempt_stage_state_latest_event_v2 "$task" "$attempt" >"$event" || { rc=$?; break; }
    status=$(PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" classify \
      "$pending" "$state" "$event" "${tree:--}") || { rc=$?; break; }
    if [[ "$replay" == 2 && "$status" != committed ]]; then
      rc=3
      break
    fi
    case "$status" in
      needs-tree)
        tree=$(_route_v2_guard_snapshot "$task" "$attempt" "${args[2]}" "${args[11]}" replay) || {
          rc=$?
          break
        }
        ;;
      ready)
        if (( commits >= 3 )); then rc=$last_rc; break; fi
        commits=$((commits + 1))
        attempt_stage_state_commit_v2 "${args[@]}" >/dev/null
        last_rc=$?
        if (( last_rc != 0 && last_rc != 1 && last_rc != 74 )); then
          rc=$last_rc
          break
        fi
        if (( last_rc != 0 )); then
          declare -F v2_log >/dev/null && \
            v2_log "${args[2]}: повтор записи перехода $commits/3, код $last_rc"
          if (( commits == 1 )); then sleep 0.1; else sleep 0.3; fi
        fi
        ;;
      committed)
        _route_v2_pending_adopt_origin "$task" "$attempt" "$pending" || { rc=$?; break; }
        if [[ "$replay" != 0 ]]; then
          runtime_lifecycle_reconcile_routing_v2 "$task" "$attempt" || { rc=$?; break; }
        else
          _route_v2_lifecycle_finish_visit_after_commit "$task" "$attempt" "${args[3]}" || {
            rc=$?
            break
          }
        fi
        _route_v2_project_completed_node \
          "$task" "$attempt" "${args[2]}" "${args[3]}" "${args[10]}" || { rc=$?; break; }
        cursor_state=$(runtime_analytics_json_get_v2 "$state" state) || { rc=$?; break; }
        stop=$(runtime_analytics_json_get_v2 "$state" stop) || { rc=$?; break; }
        # Factory должен сначала записать human projection, затем вызвать ack.
        if runtime_lifecycle_enabled_v2 && [[ "$cursor_state" == stopped && "$stop" != done ]]; then
          cat -- "$state"
          if [[ "$replay" == 0 ]]; then rc=0; else rc=21; fi
          break
        fi
        PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" remove "$pending" || { rc=$?; break; }
        cat -- "$state"
        rc=0
        break
        ;;
      stale)
        PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" archive "$pending" || { rc=$?; break; }
        declare -F v2_log >/dev/null && v2_log 'старый pending переход не использован: новый cursor/исходники'
        rc=3
        break
        ;;
      *) rc=78; break ;;
    esac
  done
  rm -rf -- "$temp"
  return "$rc"
}

# Сохраняет точный исход agent/command после всех внешних и внутренних проверок.
# Sequence сравнивается с тем, с которым узел реально был запущен.
_route_v2_commit_pending_node() {
  local sequence=$1
  shift
  local task=$1 attempt=$2 node=$3 temp tree rc
  [[ $# == 11 ]] || return 78
  temp=$(mktemp "$(factory_control_root)/.pending-state.XXXXXX") || return 74
  local prepare_try
  for prepare_try in 1 2 3; do
    rc=0
    attempt_stage_state_read_v2 "$task" "$attempt" >"$temp" || rc=$?
    if (( rc == 0 )); then
      tree=$(_route_v2_guard_snapshot "$task" "$attempt" "$node" "$sequence" pending) || rc=$?
    fi
    if (( rc == 0 )); then
      PYTHONDONTWRITEBYTECODE=1 python3 "$FACTORY_HOME/lib/pending_transition.py" prepare \
        "$ROUTE_V2_ATTEMPT_DIR/pending-transition.json" "$temp" "$sequence" "$tree" "$@"
      rc=$?
    fi
    (( rc == 0 )) && break
    (( rc == 1 || rc == 74 )) || break
    sleep 0.1
  done
  rm -f -- "$temp"
  (( rc == 0 )) || return "$rc"
  _route_v2_pending_drive "$task" "$attempt" 0
}
