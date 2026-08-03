#!/usr/bin/env bash
set -uo pipefail

FACTORY_HOME="$(cd "$(dirname "$0")/.." && pwd)"
source "$FACTORY_HOME/lib/run-state.sh"

task=${1:?task}; shift
control_fd=${FACTORY_CONTROL_FD:-8}
[[ "$control_fd" =~ ^[0-9]+$ ]] || exit 2
token=""
IFS= read -r token <&"$control_fd" || exit 74
factory_control_verify "$token" || exit 74
run_state_control_update "$task" "$@"
