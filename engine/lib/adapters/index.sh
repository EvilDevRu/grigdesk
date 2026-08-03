#!/usr/bin/env bash

declare -gA FACTORY_ADAPTER_MODULES=()

adapter_registry_reset() {
  FACTORY_ADAPTER_MODULES=()
}

adapter_registry_add() {
  local id=${1:?adapter id} module=${2:?adapter module}
  [[ "$id" =~ ^[a-z][a-z0-9_-]*$ && -f "$module" ]] || return 2
  # shellcheck disable=SC1090
  source "$module"
  FACTORY_ADAPTER_MODULES["$id"]=$module
}

adapter_registry_has() {
  [[ -n "${FACTORY_ADAPTER_MODULES[${1:-}]:-}" ]]
}

adapter_contract_check() {
  local id=${1:?adapter id} method
  adapter_registry_has "$id" || return 1
  for method in version provides preflight run; do
    declare -F "adapter_${id}_${method}" >/dev/null || return 1
  done
}

adapter_call() {
  local id=${1:?adapter id} method=${2:?method}; shift 2
  adapter_contract_check "$id" || return 2
  "adapter_${id}_${method}" "$@"
}
