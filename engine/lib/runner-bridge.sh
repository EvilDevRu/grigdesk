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
if [[ "$method" == run && "${FACTORY_BROWSER_ENABLED:-0}" == 1 ]]; then
  source "$FACTORY_HOME/lib/browser-transport.sh"
  browser_task=$1
  browser_prompt=$2
  shift 2
  browser_transport_prompt "$browser_prompt"
  "$fn" "$browser_task" "$BROWSER_TRANSPORT_PROMPT" "$@"
else
  "$fn" "$@"
fi
