#!/usr/bin/env bash

# Единый селектор типов shared hook. На Linux остаётся прежний контракт.
factory_shared_restore_mode() {
  local mode
  if [[ "$OSTYPE" != darwin* ]]; then
    declare -F profile_instrumentation_restored >/dev/null || return 78
    printf '%s\n' legacy
    return 0
  fi
  mode=$(profile_instrumentation_restore_mode 2>/dev/null) || mode=""
  case "$mode" in
    live-checkout)
      if declare -F profile_instrumentation_restored >/dev/null; then
        printf '%s\n' "$mode"
        return 0
      fi
      ;;
    copy-snapshot)
      if declare -F profile_instrumentation_restored_from_snapshot >/dev/null; then
        printf '%s\n' "$mode"
        return 0
      fi
      ;;
  esac
  printf '%s\n' 'FACTORY_ERROR=macos_shared_restore_hook_required' >&2
  return 78
}
