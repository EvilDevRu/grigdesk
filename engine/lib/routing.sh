#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/profile-config.sh"

_routing_file_get() {
  local file=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); value=$0 } END { print value }' \
    "$file" 2>/dev/null
}

_routing_chain_valid() {
  [[ "${1:-}" =~ ^[a-z][a-z0-9_-]*(,[a-z][a-z0-9_-]*)*$ ]]
}

_routing_chain_split() {
  local chain=$1
  ROUTING_PRIMARY=${chain%%,*}
  if [[ "$chain" == *,* ]]; then
    ROUTING_FAILOVER=${chain#*,}
  else
    ROUTING_FAILOVER=""
  fi
}

routing_resolve() {
  local config=$1 task_registry=$2 stage=$3 ignore_stage=${4:-0}
  profile_config_validate "$config" || return 78
  local stage_key="RUNNER_OVERRIDE_STAGE_${stage}" chain source
  chain=$(_routing_file_get "$task_registry" "$stage_key")
  [[ "$ignore_stage" != 1 ]] || chain=""
  _routing_chain_valid "$chain" || chain=""
  if [[ -n "$chain" ]]; then
    _routing_chain_split "$chain"
    source=task-stage
  else
    ROUTING_PRIMARY=$(_routing_file_get "$task_registry" RUNNER_OVERRIDE_PRIMARY)
    ROUTING_FAILOVER=$(_routing_file_get "$task_registry" RUNNER_OVERRIDE_FAILOVER)
    if ! _routing_chain_valid "$ROUTING_PRIMARY" || \
       { [[ -n "$ROUTING_FAILOVER" ]] && ! _routing_chain_valid "$ROUTING_FAILOVER"; }; then
      ROUTING_PRIMARY=""
      ROUTING_FAILOVER=""
    fi
    if [[ -n "$ROUTING_PRIMARY" ]]; then
      source=task
    else
      ROUTING_PRIMARY=$(profile_config_get "$config" "STAGE_${stage}_PRIMARY")
      ROUTING_FAILOVER=$(profile_config_get "$config" "STAGE_${stage}_FAILOVER")
      if [[ -n "$ROUTING_PRIMARY" ]]; then
        source=profile-stage
      else
        ROUTING_PRIMARY=$(profile_config_get "$config" PROJECT_RUNNER_PRIMARY)
        ROUTING_FAILOVER=$(profile_config_get "$config" PROJECT_RUNNER_FAILOVER)
        source=profile-project
      fi
    fi
  fi
  [[ -n "$ROUTING_PRIMARY" ]] || return 78
  printf 'PRIMARY=%s\nFAILOVER=%s\nSOURCE=%s\n' \
    "$ROUTING_PRIMARY" "$ROUTING_FAILOVER" "$source"
}
