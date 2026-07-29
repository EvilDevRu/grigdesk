#!/usr/bin/env bash

_factory_exec_log_violation() {
  local message=$1
  local state_root="${FACTORY_STATE:-${STATE_DIR:-}}"
  if [[ -n "$state_root" ]]; then
    mkdir -p "$state_root/logs" 2>/dev/null || true
    printf '%s\n' "$message" >>"$state_root/logs/offline-violations.log" 2>/dev/null || true
  fi
  printf '%s\n' "$message" >&2
}

factory_exec() {
  local kind=${1:?kind}; shift
  [[ $# -gt 0 ]] || return 2
  factory_exec_check "$kind" "$1" || return $?
  command "$@"
}

factory_exec_check() {
  local kind=${1:?kind} command_name=${2:?executable}
  local executable=${command_name##*/}
  if [[ "${FACTORY_FORBID_LIVE:-0}" == "1" ]]; then
    case "$executable" in
      claude|claude-*|codex|codex-*|gemini|gemini-*|curl|wget|ssh|scp|nc|ncat)
        _factory_exec_log_violation \
          "OFFLINE_GUARD: blocked executable regardless of declared kind: $command_name"
        return 126
        ;;
    esac
  fi
  case "$kind" in
    provider|network)
      if [[ "${FACTORY_FORBID_LIVE:-0}" == "1" ]]; then
        _factory_exec_log_violation \
          "OFFLINE_GUARD: blocked $kind executable: $1"
        return 126
      fi
      ;;
    local)
      ;;
    *)
      echo "unknown executor kind: $kind" >&2
      return 2
      ;;
  esac
  return 0
}

_factory_normalize_path() {
  realpath -m -- "$1" 2>/dev/null
}

factory_path_allowed() {
  local requested normalized root normalized_root
  requested=${1:?path}
  normalized=$(_factory_normalize_path "$requested") || return 1
  for root in "${FACTORY_CONFIG_ROOT:-}" "${FACTORY_STATE:-}" "${STATE_DIR:-}" \
              "${FACTORY_HOME:-}"; do
    [[ -n "$root" ]] || continue
    normalized_root=$(_factory_normalize_path "$root") || continue
    case "$normalized" in
      "$normalized_root"|"$normalized_root"/*) return 0 ;;
    esac
  done
  return 1
}

factory_read_file() {
  local path=${1:?path}
  if ! factory_path_allowed "$path"; then
    _factory_exec_log_violation "OFFLINE_GUARD: blocked read outside configured roots: $path"
    return 126
  fi
  command cat -- "$path"
}
