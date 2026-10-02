#!/usr/bin/env bash

runner_result_class_valid() {
  case "${1:-}" in
    ok|limited|unavailable_preflight|route_unavailable|manual_switch|agent_failed|\
provider_unavailable|missing_status|denied|timeout|transient|invalid_config|\
context_overflow|crashed|runtime_changed|unknown)
      return 0 ;;
    *) return 1 ;;
  esac
}

# Возврат 0 означает только «разрешено сменить provider», а не успешность запуска.
# phase: preflight|started; mode: auto|manual; manual_match: 1 только после CAS control request.
runner_transition_allowed() {
  local phase=${1:-} reason=${2:-} mode=${3:-auto} manual_match=${4:-0}
  runner_result_class_valid "$reason" || return 1
  case "$phase:$mode:$reason:$manual_match" in
    preflight:auto:unavailable_preflight:*|preflight:auto:route_unavailable:*)
      return 0 ;;
    started:auto:limited:*)
      return 0 ;;
    started:auto:provider_unavailable:*)
      return 0 ;;
    started:manual:manual_switch:1)
      return 0 ;;
    *)
      return 1 ;;
  esac
}
