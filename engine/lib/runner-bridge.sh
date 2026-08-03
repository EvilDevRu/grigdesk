#!/usr/bin/env bash
set -uo pipefail

module=${1:?runner module}
runner_id=${2:?runner id}
method=${3:?runner method}
shift 3

# shellcheck disable=SC1090
source "$module"
fn="runner_${runner_id}_${method}"
declare -F "$fn" >/dev/null || {
  echo "runner bridge: missing function $fn" >&2
  exit 2
}
if [[ "${FACTORY_LAUNCH_BARRIER:-0}" == 1 ]]; then
  kill -STOP "$$"
fi
"$fn" "$@"
