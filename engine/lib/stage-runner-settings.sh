#!/usr/bin/env bash

# CLI и launcher используют один metadata-контракт и один защищённый writer.
# Сбор каталога выполняется до locks; commit и admission держат pipeline lock.
source "${FACTORY_HOME:?}/lib/attempt-state.sh"

_stage_settings_identity() {
  jq -cn --arg task "$1" --arg profile "$2" --arg attempt "$3" --arg node "$4" --arg stage "$5" \
    '{task:$task,profile:$profile,attempt:$attempt,node:$node,stage:$stage}'
}

_stage_settings_tool() {
  local operation=$1 identity=$2
  shift 2
  python3 "$FACTORY_HOME/lib/stage-runner-settings.py" "$operation" \
    "$(factory_control_root)" "$identity" "$@"
}

# Живой процесс принадлежит узлу только при совпадении immutable lifecycle binding.
# Неудачная привязка не превращает один визуальный stage в право остановить другой node.
_stage_settings_bind_actual() {
  local task=$1 stage=$2 identity=$3 trusted run epoch trusted_stage runner pid pgid session starttime rc
  export STAGE_SETTINGS_BOUND_RUN=""
  trusted=$(runner_trusted_identity_read "$task" "$stage")
  rc=$?
  (( rc == 3 || rc == 73 )) && return 0
  (( rc == 0 )) || return "$rc"
  read -r trusted_stage run epoch runner pid pgid session starttime <<<"$trusted"
  runtime_lifecycle_bind_run_v2 "$task" "$run" "$epoch" >/dev/null 2>&1 || return 0
  if [[ "$FACTORY_LIFECYCLE_ATTEMPT_ID" == "$(jq -r .attempt <<<"$identity")" &&
        "$FACTORY_LIFECYCLE_NODE_ID" == "$(jq -r .node <<<"$identity")" &&
        "$FACTORY_LIFECYCLE_RUN_KEY" == "$stage" ]]; then
    export STAGE_SETTINGS_BOUND_RUN="$run:$epoch"
  fi
}

# Не угадываем node по stage: контекст запуска уже содержит точный узел и attempt.
# Отсутствие sidecar сохраняет прежний путь, в том числе legacy запуск без attempt.
_stage_settings_load() {
  local task=$1 stage=$2 root file
  MULTI_SETTINGS=null
  MULTI_SETTINGS_IDENTITY=""
  [[ -n "${FACTORY_LIFECYCLE_ATTEMPT_ID:-}" && -n "${FACTORY_LIFECYCLE_NODE_ID:-}" ]] || return 0
  root=$(factory_control_root) || return
  file="$root/protocol-v2/tasks/t$task/attempts/$FACTORY_LIFECYCLE_ATTEMPT_ID"
  [[ -d "$file" ]] || return 0
  file+="/runner-settings/$FACTORY_LIFECYCLE_NODE_ID.json"
  MULTI_SETTINGS_IDENTITY=$(_stage_settings_identity "$task" "$PROFILE_NAME" \
    "$FACTORY_LIFECYCLE_ATTEMPT_ID" "$FACTORY_LIFECYCLE_NODE_ID" "$stage")
  MULTI_SETTINGS=$(_stage_settings_tool read "$MULTI_SETTINGS_IDENTITY") || return
}

# Локальный primary принадлежит одному node; null возвращает актуальную базовую цепочку.
# Принятый restart сохраняет собственный snapshot даже при новой настройке future.
# Источник цепочки сохраняет именной обход предохранителя при явном выборе primary.
_stage_settings_route() {
  if [[ -n "${MULTI_FROZEN_RESTART:-}" ]]; then
    primary=$(jq -r .effective.primary <<<"$MULTI_FROZEN_RESTART")
    failover=$(jq -r '.chain[1:] | join(",")' <<<"$MULTI_FROZEN_RESTART")
    return 0
  fi
  [[ "${MULTI_SETTINGS:-null}" != null ]] || return 0
  local selected
  selected=$(jq -r '.selection.primary // empty' <<<"$MULTI_SETTINGS")
  if [[ -n "$selected" ]]; then
    primary=$selected
    failover=$(jq -r '(.failover // []) | join(",")' <<<"$MULTI_SETTINGS")
    MULTI_ROUTE_SOURCE=task-stage
  else
    local inherited_route
    inherited_route=$(routing_resolve "$(multi_runner_config_file)" \
      "$(pipeline_store_file "$MULTI_TASK")" "$MULTI_STAGE" 1) || return
    primary=$(awk -F= '$1=="PRIMARY"{print $2}' <<<"$inherited_route")
    failover=$(awk -F= '$1=="FAILOVER"{print $2}' <<<"$inherited_route")
    MULTI_ROUTE_SOURCE=$(awk -F= '$1=="SOURCE"{print $2}' <<<"$inherited_route")
  fi
}

# Callback принадлежит раннеру: неподтверждённые варианты не заменяем чатовым seed.
# Общая форма сохраняет непрозрачный modelRef и индивидуальный список уровней.
_stage_settings_models() {
  local provider=$1 models
  runner_registry_has "$provider" || {
    printf 'provider_unavailable: исполнитель %s недоступен\n' "$provider" >&2
    return 75
  }
  runner_call "$provider" probe >/dev/null || {
    printf 'provider_unavailable: раннер %s не прошёл проверку доступности\n' "$provider" >&2
    return 75
  }
  if ! models=$(runner_call "$provider" model_options); then
    printf 'metadata_unavailable: каталог моделей %s недоступен\n' "$provider" >&2
    return 69
  fi
  jq -ce '.schema == 1 and (.models | type == "array" and length > 0)
    and all(.models[]; (.id | type == "string") and (.efforts | type == "array")
    and all(.efforts[]; type == "string"))' <<<"$models" >/dev/null || {
    printf 'metadata_unavailable: неверный каталог моделей\n' >&2
    return 69
  }
  printf '%s\n' "$models"
}

# Читает профиль тем же resolver, который затем передаёт аргументы launcher-у.
# Локальный слой здесь отключён: независимые null-поля накладывает общий validator.
_stage_settings_preview() {
  local task=$1 identity=$2 provider=$3 config route primary failover source models fingerprint rc
  local inherited_route inherited_primary inherited_failover candidate_failover=""
  local saved_settings=${MULTI_SETTINGS:-null}
  config=$(multi_runner_config_file)
  route=$(routing_resolve "$config" "$(pipeline_store_file "$task")" "$MULTI_STAGE") || return 78
  primary=$(awk -F= '$1=="PRIMARY"{print $2}' <<<"$route")
  failover=$(awk -F= '$1=="FAILOVER"{print $2}' <<<"$route")
  source=$(awk -F= '$1=="SOURCE"{print $2}' <<<"$route")
  inherited_route=$(routing_resolve "$config" "$(pipeline_store_file "$task")" "$MULTI_STAGE" 1) || return
  inherited_primary=$(awk -F= '$1=="PRIMARY"{print $2}' <<<"$inherited_route")
  inherited_failover=$(awk -F= '$1=="FAILOVER"{print $2}' <<<"$inherited_route")
  if [[ "$saved_settings" != null &&
        "$(jq -r '.selection.primary | type' <<<"$saved_settings")" == null ]]; then
    source=$(awk -F= '$1=="SOURCE"{print $2}' <<<"$inherited_route")
  fi
  runner_registry_reset
  runner_registry_load "${FACTORY_RUNNERS_DIR:-$FACTORY_HOME/lib/runners}" || return 78
  if models=$(_stage_settings_models "$provider"); then
    :
  else
    rc=$?
    if [[ "${STAGE_SETTINGS_ALLOW_UNAVAILABLE:-0}" == 1 ]]; then
      models='{"schema":1,"models":[]}'
    else
      return "$rc"
    fi
  fi
  MULTI_CATALOG_ROOT=$(mktemp -d "${STATE_DIR:?}/.catalog-invoke.XXXXXX") || return
  declare -gA MULTI_PROBE_READY=() MULTI_PROBE_VERSION=() MULTI_PLAN_LEVEL=() MULTI_PLAN_DEGRADED=()
  MULTI_TASK=$task
  MULTI_SETTINGS=null
  MULTI_COVERAGE_REQUIRED=0
  _multi_resolve "$provider"
  rc=$?
  _multi_catalog_cleanup
  MULTI_SETTINGS=$saved_settings
  if (( rc != 0 )); then
    DISPATCH_RESOLVED_MODEL=""
    DISPATCH_RESOLVED_EFFORT=$(_multi_model_value "$config" "$MULTI_STAGE" "$provider" EFFORT)
    [[ -n "$DISPATCH_RESOLVED_EFFORT" ]] || DISPATCH_RESOLVED_EFFORT=high
  fi
  if [[ "${STAGE_SETTINGS_ALLOW_UNAVAILABLE:-0}" != 1 &&
        "$(profile_config_get "$config" RUNNERS_COVERAGE)" == required ]]; then
    if [[ "$provider" == "$primary" ]]; then
      candidate_failover=$failover
    fi
    if [[ "$saved_settings" != null &&
          "$(jq -r '.selection.primary // empty' <<<"$saved_settings")" == "$provider" ]]; then
      candidate_failover=$(jq -r '(.failover // []) | join(",")' <<<"$saved_settings")
    fi
    _multi_require_coverage "$task" "$MULTI_STAGE" "$config" "$provider" "$candidate_failover" || return 75
  fi
  STAGE_SETTINGS_DEFAULT_MODEL=$DISPATCH_RESOLVED_MODEL
  STAGE_SETTINGS_DEFAULT_EFFORT=$DISPATCH_RESOLVED_EFFORT
  STAGE_SETTINGS_POLICY_HASH=$(sha256sum "$config" | cut -d' ' -f1)
  STAGE_SETTINGS_SNAPSHOT_HASH=$(_stage_settings_tool catalog "$identity" "$provider") || return
  fingerprint=$(cat "$config"; printf '%s' "${MULTI_PROBE_VERSION[$provider]}"; \
    cat "$STATE_DIR/runners/catalogs/$provider/active" 2>/dev/null || true)
  _stage_settings_tool view "$identity" "$provider" "$primary" "$failover" "$source" \
    "$DISPATCH_RESOLVED_MODEL" "$DISPATCH_RESOLVED_EFFORT" "$models" "$fingerprint" \
    "$inherited_primary" "$inherited_failover"
}

# Единственный commit связывает будущую selection и restart intent. Повтор запроса
# читает receipt; ошибка после accept не отрицает уже сохранённые настройки.
stage_runner_settings_cli() {
  local task=$1 operation=${2:-} profile="" attempt="" node="" stage="" provider="" payload=""
  shift 2
  while (( $# )); do
    [[ $# -ge 2 ]] || return 2
    case "$1" in
      --profile) profile=$2 ;;
      --attempt) attempt=$2 ;;
      --node) node=$2 ;;
      --stage) stage=$2 ;;
      --provider) provider=$2 ;;
      --payload) payload=$2 ;;
      --control-dir) export FACTORY_CONTROL_ROOT=$2 ;;
      --state-dir) export STATE_DIR=$2 FACTORY_STATE=$2 ;;
      --routes-dir) : ;;
      *) return 2 ;;
    esac
    shift 2
  done
  local identity record preview lock_fd task_fd rc result request state run epoch event_file node_policy
  identity=$(_stage_settings_identity "$task" "$profile" "$attempt" "$node" "$stage")
  PROFILE_NAME=$profile
  MULTI_STAGE=$stage
  source "$FACTORY_HOME/lib/multi-runner.sh"
  if [[ "$operation" == apply ]]; then
    provider=$(_stage_settings_tool input "$identity" "$payload") || return
  fi
  record=$(_stage_settings_tool read "$identity") || return
  MULTI_SETTINGS=$record
  STAGE_SETTINGS_ALLOW_UNAVAILABLE=0
  if [[ "$operation" == show ]]; then
    STAGE_SETTINGS_ALLOW_UNAVAILABLE=1
  elif [[ "$operation" == apply ]]; then
    _stage_settings_tool replay "$identity" "$payload"
    rc=$?
    if (( rc == 0 )); then
      STAGE_SETTINGS_ALLOW_UNAVAILABLE=1
    elif (( rc != 3 )); then
      return "$rc"
    fi
  fi
  node_policy=$(_stage_settings_tool policy "$identity") || return
  export FACTORY_ROUTE_FILESYSTEM_POLICY
  export FACTORY_ROUTE_FANOUT_MODE FACTORY_ROUTE_FANOUT_MAX FACTORY_ROUTE_FANOUT_DEGRADE
  FACTORY_ROUTE_FILESYSTEM_POLICY=$(jq -r .policy.filesystem <<<"$node_policy")
  FACTORY_ROUTE_FANOUT_MODE=$(jq -r .fanout.mode <<<"$node_policy")
  FACTORY_ROUTE_FANOUT_MAX=$(jq -r .fanout.maxExecutors <<<"$node_policy")
  FACTORY_ROUTE_FANOUT_DEGRADE=$(jq -r .fanout.degrade <<<"$node_policy")
  _stage_settings_bind_actual "$task" "$stage" "$identity" || return
  [[ -n "$provider" ]] || provider=$(jq -r '.selection.parametersFor // empty' <<<"$record")
  if [[ -z "$provider" ]]; then
    local route
    route=$(routing_resolve "$(multi_runner_config_file)" "$(pipeline_store_file "$task")" "$stage") || return
    provider=$(awk -F= '$1=="PRIMARY"{print $2}' <<<"$route")
  fi
  [[ "$provider" =~ ^[a-z][a-z0-9_-]*$ ]] || return 2
  local preview_file
  preview_file=$(mktemp "${TMPDIR:-/tmp}/stage-settings.XXXXXX") || return 1
  _stage_settings_preview "$task" "$identity" "$provider" >"$preview_file"
  rc=$?
  preview=$(cat "$preview_file")
  rm -f -- "$preview_file"
  (( rc == 0 )) || return "$rc"
  case "$operation" in
    show|options) printf '%s\n' "$preview"; return 0 ;;
    apply) ;;
    *) return 2 ;;
  esac
  pipeline_lock_acquire "$task" lock_fd || return
  _stage_settings_bind_actual "$task" "$stage" "$identity" || {
    pipeline_lock_release "$lock_fd"
    return 78
  }
  _attempt_state_lock "$task" task_fd || {
    pipeline_lock_release "$lock_fd"
    return 1
  }
  result=$(_stage_settings_tool apply "$identity" "$payload" "$preview" \
    "$STAGE_SETTINGS_DEFAULT_MODEL" "$STAGE_SETTINGS_DEFAULT_EFFORT" \
    "$(multi_runner_config_file)" "$STAGE_SETTINGS_POLICY_HASH" "$provider" "$STAGE_SETTINGS_SNAPSHOT_HASH")
  rc=$?
  _attempt_state_unlock "$task_fd"
  pipeline_lock_release "$lock_fd"
  (( rc == 0 )) || return "$rc"
  request=$(jq -r '.requestId' <<<"$payload")
  state=$(jq -r '.receipt.state' <<<"$result")
  if [[ "$(jq -r .mode <<<"$payload")" == restart && "$state" == pending ]]; then
    run=$(jq -r '.expectedRun.id' <<<"$payload")
    epoch=$(jq -r '.expectedRun.epoch' <<<"$payload")
    record=$(_stage_settings_tool read "$identity") || return
    event_file=$(mktemp "$(factory_control_root)/.settings-event.XXXXXX") || return 1
    jq -c .pending.eventDraft <<<"$record" >"$event_file"
    if ! attempt_lifecycle_append_v2 "$task" "$attempt" "$event_file" >/dev/null; then
      _stage_settings_receipt "$identity" "$request" failed 'lifecycle: не удалось записать перезапуск'
    else
      _stage_settings_receipt "$identity" "$request" published '' || return
      if ! runtime_interrupt_trusted_active "$task" "$stage" "$run" "$epoch" \
        "${FACTORY_SWITCH_GRACE_SECONDS:-5}"; then
        _stage_settings_receipt "$identity" "$request" failed \
          'stop: не удалось остановить точный запуск' pending
      fi
    fi
    rm -f -- "$event_file"
  fi
  # Снимок accept возвращаем даже если оркестратор уже успел закрыть run.
  record=$(_stage_settings_tool read "$identity") || return
  jq --argjson record "$record" '.receipt=$record.receipt' <<<"$result"
}

# Результат после accept меняется под тем же порядком locks, что и исходная selection.
# RequestId запрещает позднему завершению перезаписать receipt нового действия человека.
# Ожидаемое состояние защищает уже consumed restart от запоздалого отказа остановки.
_stage_settings_receipt() {
  local identity=$1 request=$2 state=$3 reason=$4 task lock_fd task_fd rc
  local expected_state=${5:-}
  task=$(jq -r .task <<<"$identity")
  pipeline_lock_acquire "$task" lock_fd || return
  _attempt_state_lock "$task" task_fd || {
    pipeline_lock_release "$lock_fd"
    return 1
  }
  if [[ "$state" == published ]]; then
    _stage_settings_tool published "$identity" "$request"
  else
    local -a receipt_args=("$request" "$state" "$reason")
    [[ -z "$expected_state" ]] || receipt_args+=("$expected_state")
    _stage_settings_tool receipt "$identity" "${receipt_args[@]}"
  fi
  rc=$?
  _attempt_state_unlock "$task_fd"
  pipeline_lock_release "$lock_fd"
  return "$rc"
}
