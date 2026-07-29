#!/usr/bin/env bash

declare -gA FACTORY_RUNNER_MODULES=()

runner_registry_reset() {
  FACTORY_RUNNER_MODULES=()
}

runner_registry_add() {
  local id=${1:?runner id} module=${2:?runner module}
  [[ "$id" =~ ^[a-z][a-z0-9_-]*$ ]] || return 2
  [[ -f "$module" ]] || return 2
  # shellcheck disable=SC1090
  source "$module"
  FACTORY_RUNNER_MODULES["$id"]=$module
}

runner_registry_load() {
  local dir=${1:?runner dir} module id
  for module in "$dir"/*.sh; do
    [[ -f "$module" ]] || continue
    id=$(basename "$module" .sh)
    [[ "$id" == index || "$id" == policy || "$id" == catalog ]] && continue
    runner_registry_add "$id" "$module" || return
  done
}

runner_registry_has() {
  [[ -n "${FACTORY_RUNNER_MODULES[${1:-}]:-}" ]]
}

runner_module_path() {
  local id=${1:?runner id}
  runner_registry_has "$id" || return 2
  printf '%s\n' "${FACTORY_RUNNER_MODULES[$id]}"
}

runner_contract_check() {
  local id=${1:?runner id} method
  runner_registry_has "$id" || return 1
  for method in probe catalog capabilities run classify fanout_count dialect interrupt; do
    declare -F "runner_${id}_${method}" >/dev/null || return 1
  done
}

runner_call() {
  local id=${1:?runner id} method=${2:?runner method}; shift 2
  runner_contract_check "$id" || return 2
  "runner_${id}_${method}" "$@"
}
