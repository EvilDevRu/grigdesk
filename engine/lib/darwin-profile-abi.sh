#!/usr/bin/env bash

# Проверка объявления канала не вызывает descriptor и не открывает ресурс.
factory_darwin_profile_abi() {
  [[ "$OSTYPE" == darwin* ]] || return 0
  if { declare -F profile_agent_control_start >/dev/null ||
       declare -F profile_agent_control_stop >/dev/null; } &&
     ! declare -F profile_agent_control_darwin_v1 >/dev/null; then
    printf '%s\n' 'FACTORY_ERROR=unsupported_macos_profile HOOK=agent_control' >&2
    return 78
  fi
}

factory_darwin_profile_channel_open() {
  local task=$1 stage=$2 owner=$3 attempt=${V2_ATTEMPT:-} control txid txrc=0 descriptor
  local visit=${FACTORY_DARWIN_BOOTSTRAP_VISIT:-${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}}
  control=$(factory_control_root) || return 78
  txid=$(_route_v2_transaction_active_id "$task") || txrc=$?
  if (( txrc == 0 )); then
    [[ "$txid" =~ ^v2-${attempt#*_}-s[0-9]+$ ]] || return 78
  elif (( txrc != 3 )); then
    return "$txrc"
  elif [[ -d "$control/transactions/t$task" ]]; then
    python3 "$FACTORY_HOME/lib/darwin-transaction-begin.py" \
      pending "$control/transactions/t$task" "$task" "$attempt" >/dev/null
    [[ $? == 3 ]] || return 78
  fi
  descriptor=$(profile_agent_control_darwin_v1 "$task" "$stage") || return 78
  python3 "$FACTORY_HOME/lib/darwin-profile-channel.py" open "$control" "$task" "$attempt" "$PF_FILE" \
    "$FACTORY_DARWIN_PROCESS_HELPER" "$stage" "$visit" "$txid" "$owner" "$FACTORY_DARWIN_SETSID" \
    <<<"$descriptor"
}

factory_darwin_profile_channel_close() {
  local task=$1 attempt=$2 rc=$3 control
  control=$(factory_control_root) || return 78
  python3 "$FACTORY_HOME/lib/darwin-profile-channel.py" close "$control" "$task" "$attempt" "$PF_FILE" \
    "$FACTORY_DARWIN_PROCESS_HELPER" "$rc"
}
