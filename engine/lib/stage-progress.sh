#!/usr/bin/env bash
set -uo pipefail

FACTORY_HOME="$(cd "$(dirname "$0")/.." && pwd)"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/status-request.sh"

task="" stage="" run_id="" epoch=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) task=${2:-}; shift 2 ;;
    --stage) stage=${2:-}; shift 2 ;;
    --run-id) run_id=${2:-}; shift 2 ;;
    --epoch) epoch=${2:-}; shift 2 ;;
    *) break ;;
  esac
done
[[ -n "$task" && -n "$stage" && -n "$run_id" && -n "$epoch" && $# -ge 2 ]] || exit 2

status_fd=${FACTORY_STATUS_FD:-7}
if [[ "$status_fd" =~ ^[0-9]+$ && -r "/proc/self/fd/$status_fd" ]]; then
  token=$(head -1 "/proc/self/fd/$status_fd") || exit 74
  run_state_apply_progress "$task" "$stage" "$run_id" "$epoch" "$token" "$@"
else
  status_request_progress "$task" "$stage" "$run_id" "$epoch" "$@"
fi
