#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/profile-config.sh"
source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/routing.sh"
source "$FACTORY_HOME/lib/runners-catalog.sh"
source "$FACTORY_HOME/lib/runtime-switch.sh"
source "$FACTORY_HOME/lib/debug-settings.sh"

_runner_cli_usage() {
  cat <<'EOF'
Исполнители:
  factory runners
  factory profile <name> runner show
  factory profile <name> runner set [STAGE] <primary> [--failover a,b]
  factory profile <name> runner clear [STAGE]
  factory profile <name> model set <STAGE> <provider> family=x version=latest effort=high
  factory profile <name> model show <STAGE> <provider>
  factory settings debug show|set <off|errors|decisions|verbose>|clear
  factory profile <name> debug show|set <level> [--for 2h]|clear
  factory <TASK> debug show|set <level> [--for 2h]|clear
  factory <TASK> runner show
  factory <TASK> runner set [STAGE] <primary> [--failover a,b]
  factory <TASK> runner clear [STAGE]
  factory <TASK> runner switch [STAGE] <provider>
EOF
}

_runner_cli_provider_valid() {
  [[ "${1:-}" =~ ^[a-z][a-z0-9_-]*$ ]]
}

_runner_cli_chain_valid() {
  [[ -z "${1:-}" || "${1:-}" =~ ^[a-z][a-z0-9_-]*(,[a-z][a-z0-9_-]*)*$ ]]
}

_runner_cli_parse_set() {
  local first=${1:-}
  [[ -n "$first" ]] || return 2
  shift
  RUNNER_CLI_STAGE=""
  if [[ "$first" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
    RUNNER_CLI_STAGE=$first
    RUNNER_CLI_PRIMARY=${1:-}
    [[ $# -gt 0 ]] && shift
  else
    RUNNER_CLI_PRIMARY=$first
  fi
  RUNNER_CLI_FAILOVER=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --failover) RUNNER_CLI_FAILOVER=${2:-}; shift 2 ;;
      *) return 2 ;;
    esac
  done
  _runner_cli_provider_valid "$RUNNER_CLI_PRIMARY" &&
    _runner_cli_chain_valid "$RUNNER_CLI_FAILOVER"
}

_runner_cli_profile_write() {
  local file=$1; shift
  local revision attempt rc
  for attempt in 1 2 3; do
    revision=$(profile_config_get "$file" CONFIG_REVISION)
    [[ "$revision" =~ ^[0-9]+$ ]] || revision=0
    profile_config_write "$file" "$revision" "$@"
    rc=$?
    [[ $rc -eq 72 ]] || return "$rc"
  done
  return 72
}

_runner_cli_require_config() {
  local file=$1
  profile_config_validate "$file" && return 0
  echo "canonical runner config обязателен: $file" >&2
  return 78
}

_runner_cli_debug_parse_set() {
  local level=${1:-} duration="" seconds now
  debug_settings_level_valid "$level" && [[ "$level" != inherit ]] || return 2
  shift
  while (( $# > 0 )); do
    case "$1" in
      --for)
        [[ $# -ge 2 && -z "$duration" ]] || return 2
        duration=$2
        shift 2
        ;;
      *)
        return 2
        ;;
    esac
  done
  RUNNER_CLI_DEBUG_LEVEL=$level
  RUNNER_CLI_DEBUG_EXPIRES=0
  if [[ -n "$duration" ]]; then
    seconds=$(debug_settings_duration_seconds "$duration") || return 2
    now=$(debug_settings_now)
    RUNNER_CLI_DEBUG_EXPIRES=$((now + seconds))
  fi
}

_runner_cli_debug_file_write() {
  local file=$1 level=$2 expires=$3 revision attempt rc
  for attempt in 1 2 3; do
    revision=$(debug_settings_get "$file" CONFIG_REVISION)
    [[ "$revision" =~ ^[0-9]+$ ]] || revision=0
    debug_settings_write "$file" "$revision" "$level" "$expires"
    rc=$?
    [[ $rc -eq 72 ]] || return "$rc"
  done
  return 72
}

_runner_cli_debug_show() {
  local scope=$1 configured=$2 configured_expires=$3 profile=${4:-} task=${5:-}
  local resolved effective source expires
  resolved=$(debug_settings_resolve "$profile" "$task" "$(debug_settings_now)") || return
  effective=$(awk -F= '$1=="LEVEL"{print $2}' <<<"$resolved")
  source=$(awk -F= '$1=="SOURCE"{print $2}' <<<"$resolved")
  expires=$(awk -F= '$1=="EXPIRES_AT"{print $2}' <<<"$resolved")
  [[ -n "$configured" ]] || configured=inherit
  [[ -n "$configured_expires" ]] || configured_expires=0
  printf 'scope: %s\nconfigured: %s\nconfigured_expires_at: %s\n' \
    "$scope" "$configured" "$configured_expires"
  printf 'effective: %s\nsource: %s\nexpires_at: %s\n' \
    "$effective" "$source" "$expires"
}

_runner_cli_settings() {
  local noun=${1:-} verb=${2:-}
  shift 2 2>/dev/null || return 2
  [[ "$noun" == debug ]] || return 2
  local file configured configured_expires
  file=$(debug_settings_global_file)
  case "$verb" in
    set)
      _runner_cli_debug_parse_set "$@" || return 2
      _runner_cli_debug_file_write "$file" "$RUNNER_CLI_DEBUG_LEVEL" \
        "$RUNNER_CLI_DEBUG_EXPIRES"
      ;;
    clear)
      [[ $# -eq 0 ]] || return 2
      _runner_cli_debug_file_write "$file" inherit 0
      ;;
    show)
      [[ $# -eq 0 ]] || return 2
      configured=$(debug_settings_get "$file" LEVEL)
      configured_expires=$(debug_settings_get "$file" EXPIRES_AT)
      _runner_cli_debug_show global "$configured" "$configured_expires"
      ;;
    *)
      return 2
      ;;
  esac
}

_runner_cli_profile() {
  local profile=${1:-} noun=${2:-} verb=${3:-}
  shift 3 2>/dev/null || return 2
  [[ "$profile" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 2
  [[ -n "$profile" && ( "$noun" == runner || "$noun" == model || "$noun" == debug ) ]] \
    || return 2
  local profiles_dir=${FACTORY_PROFILES_DIR:-"$(cd "$FACTORY_HOME/.." && pwd)/profiles"}
  local profile_file="$profiles_dir/$profile/profile.sh"
  local config="$profiles_dir/$profile/runners.env"
  [[ -f "$profile_file" || -f "$config" ]] || {
    echo "профиль не найден: $profile" >&2
    return 1
  }
  if [[ "$noun" == debug ]]; then
    local debug_file configured configured_expires
    debug_file=$(debug_settings_profile_file "$profile") || return 2
    case "$verb" in
      set)
        _runner_cli_debug_parse_set "$@" || return 2
        _runner_cli_debug_file_write "$debug_file" "$RUNNER_CLI_DEBUG_LEVEL" \
          "$RUNNER_CLI_DEBUG_EXPIRES"
        ;;
      clear)
        [[ $# -eq 0 ]] || return 2
        _runner_cli_debug_file_write "$debug_file" inherit 0
        ;;
      show)
        [[ $# -eq 0 ]] || return 2
        configured=$(debug_settings_get "$debug_file" LEVEL)
        configured_expires=$(debug_settings_get "$debug_file" EXPIRES_AT)
        _runner_cli_debug_show profile "$configured" "$configured_expires" "$profile"
        ;;
      *)
        return 2
        ;;
    esac
    return
  fi
  if [[ "$noun" == model ]]; then
    local stage=${1:-} provider=${2:-} provider_key pair field value
    [[ "$stage" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 2
    _runner_cli_provider_valid "$provider" || return 2
    provider_key=$(_runner_cli_provider_key "$provider")
    shift 2
    _runner_cli_require_config "$config" || return
    case "$verb" in
      set)
        [[ $# -gt 0 ]] || return 2
        local -a updates=()
        for pair in "$@"; do
          [[ "$pair" == *=* ]] || return 2
          field=${pair%%=*}; value=${pair#*=}
          field=${field^^}
          case "$field" in FAMILY|FAMILY_FAILOVER|VERSION|VARIANT|EFFORT|EXACT) ;; *) return 2 ;; esac
          updates+=("MODEL_${stage}_${provider_key}_${field}" "$value")
        done
        _runner_cli_profile_write "$config" "${updates[@]}"
        ;;
      show)
        printf '%s/%s:' "$stage" "$provider"
        for field in FAMILY FAMILY_FAILOVER VERSION VARIANT EFFORT EXACT; do
          value=$(profile_config_get "$config" "MODEL_${stage}_${provider_key}_${field}")
          [[ -z "$value" ]] || printf ' %s=%s' "${field,,}" "$value"
        done
        printf '\n'
        ;;
      clear)
        _runner_cli_profile_write "$config" \
          "MODEL_${stage}_${provider_key}_FAMILY" "" \
          "MODEL_${stage}_${provider_key}_FAMILY_FAILOVER" "" \
          "MODEL_${stage}_${provider_key}_VERSION" "" \
          "MODEL_${stage}_${provider_key}_VARIANT" "" \
          "MODEL_${stage}_${provider_key}_EFFORT" "" \
          "MODEL_${stage}_${provider_key}_EXACT" ""
        ;;
      *) return 2 ;;
    esac
    return
  fi
  case "$verb" in
    set)
      _runner_cli_parse_set "$@" || return 2
      if [[ ! -f "$config" ]]; then
        [[ -z "$RUNNER_CLI_STAGE" ]] || {
          echo "сначала создай project policy: factory profile $profile runner set <primary>" >&2
          return 78
        }
        profile_config_create "$config" "$RUNNER_CLI_PRIMARY" "$RUNNER_CLI_FAILOVER"
        return $?
      fi
      _runner_cli_require_config "$config" || return
      if [[ -n "$RUNNER_CLI_STAGE" ]]; then
        _runner_cli_profile_write "$config" \
          "STAGE_${RUNNER_CLI_STAGE}_PRIMARY" "$RUNNER_CLI_PRIMARY" \
          "STAGE_${RUNNER_CLI_STAGE}_FAILOVER" "$RUNNER_CLI_FAILOVER"
      else
        _runner_cli_profile_write "$config" \
          PROJECT_RUNNER_PRIMARY "$RUNNER_CLI_PRIMARY" \
          PROJECT_RUNNER_FAILOVER "$RUNNER_CLI_FAILOVER"
      fi
      ;;
    clear)
      _runner_cli_require_config "$config" || return
      if [[ -n "${1:-}" ]]; then
        [[ "$1" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 2
        _runner_cli_profile_write "$config" "STAGE_${1}_PRIMARY" "" "STAGE_${1}_FAILOVER" ""
      else
        echo "project primary обязателен; задай новый через runner set" >&2
        return 2
      fi
      ;;
    show)
      _runner_cli_require_config "$config" || return
      local primary failover key stage
      primary=$(profile_config_get "$config" PROJECT_RUNNER_PRIMARY)
      failover=$(profile_config_get "$config" PROJECT_RUNNER_FAILOVER)
      printf '%s: %s%s\n' "$profile" "$primary" "${failover:+ -> $failover}"
      while IFS= read -r key; do
        stage=${key#STAGE_}; stage=${stage%_PRIMARY}
        primary=$(profile_config_get "$config" "$key")
        [[ -n "$primary" ]] || continue
        failover=$(profile_config_get "$config" "STAGE_${stage}_FAILOVER")
        printf '%s: %s%s\n' "$stage" "$primary" "${failover:+ -> $failover}"
      done < <(awk -F= '$1 ~ /^STAGE_[A-Z0-9_]+_PRIMARY$/ {print $1}' "$config" | sort)
      ;;
    *) return 2 ;;
  esac
}

_runner_cli_provider_key() {
  printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_'
}

_runner_cli_active_stage() {
  local task=$1 requested=${2:-} file key value found=""
  file=$(pipeline_store_file "$task")
  if [[ -n "$requested" ]]; then
    value=$(pipeline_store_get "$task" "ACTIVE_RUN_${requested}")
    [[ -n "$value" ]] || return 1
    printf '%s\n' "$requested"
    return
  fi
  while IFS='=' read -r key value; do
    [[ "$key" == ACTIVE_RUN_* && -n "$value" ]] || continue
    [[ -z "$found" ]] || return 2
    found=${key#ACTIVE_RUN_}
  done <"$file"
  [[ -n "$found" ]] || return 1
  printf '%s\n' "$found"
}

_runner_cli_task() {
  local task=${1#[tT]} noun=${2:-} verb=${3:-}
  shift 3 2>/dev/null || return 2
  [[ "$task" =~ ^[0-9]+$ && ( "$noun" == runner || "$noun" == debug ) ]] || return 2
  local file
  file=$(pipeline_store_file "$task")
  [[ -f "$file" ]] || {
    echo "задача t$task не найдена" >&2
    return 1
  }
  if [[ "$noun" == debug ]]; then
    local configured configured_expires profile
    case "$verb" in
      set)
        _runner_cli_debug_parse_set "$@" || return 2
        if [[ "$RUNNER_CLI_DEBUG_EXPIRES" == 0 && "$RUNNER_CLI_DEBUG_LEVEL" != off ]]; then
          local default_ttl=${FACTORY_DEBUG_TASK_DEFAULT_TTL:-7200}
          [[ "$default_ttl" =~ ^[1-9][0-9]*$ ]] &&
            (( default_ttl > 0 && default_ttl <= 31536000 )) || return 2
          RUNNER_CLI_DEBUG_EXPIRES=$(( $(debug_settings_now) + default_ttl ))
        fi
        debug_settings_task_write "$task" "$RUNNER_CLI_DEBUG_LEVEL" \
          "$RUNNER_CLI_DEBUG_EXPIRES"
        ;;
      clear)
        [[ $# -eq 0 ]] || return 2
        debug_settings_task_write "$task" inherit 0
        ;;
      show)
        [[ $# -eq 0 ]] || return 2
        configured=$(pipeline_store_get "$task" DEBUG_LEVEL)
        configured_expires=$(pipeline_store_get "$task" DEBUG_EXPIRES_AT)
        profile=$(pipeline_store_get "$task" PROFILE)
        _runner_cli_debug_show task "$configured" "$configured_expires" "$profile" "$task"
        ;;
      *)
        return 2
        ;;
    esac
    return
  fi
  case "$verb" in
    set)
      _runner_cli_parse_set "$@" || return 2
      if [[ -n "$RUNNER_CLI_STAGE" ]]; then
        pipeline_store_update "$task" "RUNNER_OVERRIDE_STAGE_${RUNNER_CLI_STAGE}" \
          "$RUNNER_CLI_PRIMARY${RUNNER_CLI_FAILOVER:+,$RUNNER_CLI_FAILOVER}"
      else
        pipeline_store_update "$task" RUNNER_OVERRIDE_PRIMARY "$RUNNER_CLI_PRIMARY" \
          RUNNER_OVERRIDE_FAILOVER "$RUNNER_CLI_FAILOVER"
      fi
      ;;
    clear)
      if [[ -n "${1:-}" ]]; then
        [[ "$1" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 2
        pipeline_store_update "$task" "RUNNER_OVERRIDE_STAGE_${1}" ""
      else
        pipeline_store_update "$task" RUNNER_OVERRIDE_PRIMARY "" RUNNER_OVERRIDE_FAILOVER ""
      fi
      ;;
    show)
      local profile config route primary failover source stage=${1:-BUILD}
      profile=$(pipeline_store_get "$task" PROFILE)
      config="${FACTORY_PROFILES_DIR:-"$(cd "$FACTORY_HOME/.." && pwd)/profiles"}/${profile}/runners.env"
      route=$(routing_resolve "$config" "$file" "$stage") || {
        echo "canonical runner config задачи t$task отсутствует или некорректен" >&2
        return 78
      }
      primary=$(awk -F= '$1=="PRIMARY"{print $2}' <<<"$route")
      failover=$(awk -F= '$1=="FAILOVER"{print $2}' <<<"$route")
      source=$(awk -F= '$1=="SOURCE"{print $2}' <<<"$route")
      printf 'task: t%s\nstage: %s\nprimary: %s\nfailover: %s\nsource: %s\n' \
        "$task" "$stage" "$primary" "$failover" "$source"
      ;;
    switch)
      local stage target active run_id epoch request_id identity
      if [[ "${1:-}" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
        stage=$1; target=${2:-}
      else
        stage=""; target=${1:-}
      fi
      _runner_cli_provider_valid "$target" || return 2
      stage=$(_runner_cli_active_stage "$task" "$stage") || {
        echo "нет однозначного активного этапа t$task" >&2
        return 1
      }
      active=$(run_state_active_file "$task" "$stage")
      run_id=$(_run_state_get "$active" RUN_ID)
      epoch=$(_run_state_get "$active" EPOCH)
      # STATE_DIR намеренно доступен провайдеру для записи. Поэтому идентичность процесса
      # берётся только из точной записи управляющего контура, опубликованной, пока раннер
      # ещё находился за барьером запуска.
      identity=$(runner_trusted_identity_read "$task" "$stage" "$run_id" "$epoch") || {
        echo "trusted process identity активного runner недоступна" >&2
        return 73
      }
      request_id="switch-$(date +%s)-$$-$RANDOM"
      runtime_switch_request "$task" "$stage" "$run_id" "$epoch" "$target" "$request_id" || return
      runtime_interrupt_trusted_active "$task" "$stage" "$run_id" "$epoch" \
        "${FACTORY_SWITCH_GRACE_SECONDS:-5}" || return
      printf 't%s %s: переключение %s запрошено\n' "$task" "$stage" "$target"
      ;;
    *) return 2 ;;
  esac
}

factory_runner_cli() {
  case "${1:-}" in
    runners)
      runners_catalog_list
      ;;
    profile)
      shift
      _runner_cli_profile "$@"
      ;;
    settings)
      shift
      _runner_cli_settings "$@"
      ;;
    [tT]*|[0-9]*)
      _runner_cli_task "$@"
      ;;
    help|--help|-h) _runner_cli_usage ;;
    *) return 2 ;;
  esac
}
