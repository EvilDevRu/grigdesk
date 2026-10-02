#!/usr/bin/env bash

_execution_env_get() {
  local file=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null
}

_execution_csv_has() {
  local csv=",${1// /}," needle=$2
  [[ "$csv" == *",$needle,"* ]]
}

_execution_csv_append_unique() {
  local current=$1 value=$2
  if [[ -z "$current" ]]; then
    printf '%s\n' "$value"
  elif _execution_csv_has "$current" "$value"; then
    printf '%s\n' "$current"
  else
    printf '%s,%s\n' "$current" "$value"
  fi
}

execution_plan_build() {
  local requirements=${1:?requirements file} native_caps=${2:-} adapter_ids=${3:-}
  local schema required degradable cap adapter provides
  local adapters_used="" degraded="" missing="" filled level=native
  schema=$(_execution_env_get "$requirements" REQUIREMENTS_SCHEMA)
  [[ "$schema" == 1 ]] || {
    printf 'PLAN_LEVEL=unavailable\nPLAN_MISSING=invalid_requirements_schema\n'
    return 0
  }
  required=$(_execution_env_get "$requirements" REQUIRED_CAPS)
  degradable=$(_execution_env_get "$requirements" DEGRADABLE_CAPS)
  local IFS=,
  for cap in $required; do
    [[ -n "$cap" ]] || continue
    if _execution_csv_has "$native_caps" "$cap"; then
      continue
    fi
    filled=0
    for adapter in $adapter_ids; do
      [[ -n "$adapter" ]] || continue
      adapter_contract_check "$adapter" || continue
      adapter_call "$adapter" preflight >/dev/null 2>&1 || continue
      provides=$(adapter_call "$adapter" provides)
      if _execution_csv_has "$provides" "$cap"; then
        adapters_used=$(_execution_csv_append_unique "$adapters_used" \
          "$adapter@$(adapter_call "$adapter" version)")
        filled=1
        break
      fi
    done
    (( filled == 1 )) && continue
    if _execution_csv_has "$degradable" "$cap"; then
      degraded=$(_execution_csv_append_unique "$degraded" "$cap")
    else
      missing=$(_execution_csv_append_unique "$missing" "$cap")
    fi
  done
  if [[ -n "$missing" ]]; then
    level=unavailable
  elif [[ -n "$degraded" ]]; then
    level=degraded
  elif [[ -n "$adapters_used" ]]; then
    level=adapted
  fi
  printf 'PLAN_LEVEL=%s\nPLAN_ADAPTERS=%s\nPLAN_DEGRADED=%s\nPLAN_MISSING=%s\n' \
    "$level" "$adapters_used" "$degraded" "$missing"
}

execution_plan_runtime_classify() {
  local rc=${1:-1} hint=${2:-unknown}
  case "$hint" in
    unavailable_preflight|route_unavailable) EXECUTION_RUNTIME_CLASS=unknown ;;
    denied|timeout|transient|invalid_config|context_overflow|crashed|runtime_changed|unknown)
      EXECUTION_RUNTIME_CLASS=$hint ;;
    *) [[ "$rc" == 0 ]] && EXECUTION_RUNTIME_CLASS=ok || EXECUTION_RUNTIME_CLASS=unknown ;;
  esac
}
