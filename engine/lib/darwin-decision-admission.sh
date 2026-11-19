#!/usr/bin/env bash

# Вход не создаёт каталогов, lock или task metadata. Родитель передаёт reader
# только проверенные пути и удерживает оба lock до полного выхода сессии чтения.
factory_darwin_admit_existing() {
  local mode=$1 control=$2 state=$3 task=$4 attempt=$5 profile=$6 profile_file=$7 expected_stage=${8:-}
  local task_root="$control/protocol-v2/tasks/t$task" lock_root="$control/protocol-v2/orchestrators"
  local directory attempt_lock scratch result diagnostics reader_pid rc=0 signal_code=0
  local helper=${FACTORY_DARWIN_PROCESS_HELPER:-} launcher=${FACTORY_DARWIN_SETSID:-}
  for directory in "$state" "$control" "$lock_root" "$task_root" "$task_root/attempts/$attempt"; do
    python3 "$FACTORY_HOME/lib/darwin-owned-directory.py" --verify "$directory" >/dev/null || return 78
  done
  [[ "$helper" == /* && "$launcher" == /* && "$BASH" == /* ]] || return 78
  [[ -f "$lock_root/t${task}.lock" && ! -L "$lock_root/t${task}.lock" ]] || return 78
  exec {V2_LOCK_FD}<"$lock_root/t${task}.lock" || return 78
  if ! "$helper" verify-task-lock "$task" 3<&"$V2_LOCK_FD" 4<"$lock_root"; then
    return 78
  fi
  exec {attempt_lock}<"$task_root" || return 78
  if ! flock -n "$V2_LOCK_FD" || ! flock -n "$attempt_lock"; then
    exec {attempt_lock}<&- {V2_LOCK_FD}<&-
    printf '%s\n' 'FACTORY_ERROR=release_drain_busy' >&2
    return 75
  fi
  "$helper" verify-task-lock "$task" 3<&"$V2_LOCK_FD" 4<"$lock_root" || return 78
  python3 "$FACTORY_HOME/lib/darwin-owned-directory.py" --verify-fd "$task_root" \
    3<&"$attempt_lock" >/dev/null || return 78
  if [[ "$mode" != stop-cleanup ]]; then
    factory_darwin_runtime_context_required "$control" "$task" "$attempt" || return
  fi
  scratch=$(mktemp -d /private/tmp/grigdesk-read.XXXXXX) || return 78
  result="$scratch/result.json"
  diagnostics="$scratch/diagnostics"
  trap 'signal_code=${signal_code:-143}; (( signal_code != 0 )) || signal_code=143' TERM
  trap 'signal_code=${signal_code:-130}; (( signal_code != 0 )) || signal_code=130' INT
  (
    exec {V2_LOCK_FD}<&- {attempt_lock}<&-
    [[ "${FACTORY_RUNTIME_CONTEXT_REQUIRED:-0}" != 1 ]] || exec 3<&-
    unset BASH_ENV ENV
    export STATE_DIR="$state" FACTORY_STATE="$state"
    exec python3 "$FACTORY_HOME/lib/darwin-decision-reader.py" "$helper" "$launcher" \
      "$BASH" "$FACTORY_HOME/lib/darwin-decision-read.sh" \
      "$control" "$task" "$attempt" "$profile" "$mode" "$profile_file" "$scratch" "$expected_stage" "${@:9}"
  ) >"$result" 2>"$diagnostics" &
  reader_pid=$!
  if (( signal_code == 0 )); then
    wait "$reader_pid" || rc=$?
  fi
  if (( signal_code != 0 )); then
    trap '' TERM INT
    kill -TERM "$reader_pid" 2>/dev/null || true
    wait "$reader_pid" 2>/dev/null || true
    rc=$signal_code
  elif (( rc == 0 )); then
    jq -e --arg profile "$profile" '.profile == $profile' "$result" >/dev/null || rc=78
  else
    sed -n -E '/^FACTORY_ERROR=[a-z_]+$/p' "$diagnostics" >&2
  fi
  if (( signal_code != 0 )) && grep -qx 'FACTORY_ERROR=release_activity_unknown' "$diagnostics"; then
    printf '%s\n' 'FACTORY_ERROR=release_activity_unknown' >&2
    rc=78
  fi
  flock -u "$attempt_lock" || rc=78
  exec {attempt_lock}<&-
  rm -rf -- "$scratch"
  trap - TERM INT
  if (( rc == 0 )) && [[ "$mode" =~ ^(gate|goto|abandon|bootstrap-answer)$ ]]; then
    factory_darwin_commit_runtime_context "$control" "$task" "$attempt" "$profile" || rc=$?
  fi
  return "$rc"
}

# Прямой CLI проверяет pending по физической попытке под task lock.
# Required marker запрещает переход в standalone при закрытом FD.
factory_darwin_runtime_context_required() {
  local control=$1 task=$2 attempt=$3
  if [[ "${FACTORY_RUNTIME_CONTEXT_REQUIRED:-0}" == 1 ]]; then
    if ! ( : <&3 ) 2>/dev/null; then
      printf '%s\n' 'FACTORY_ERROR=factory_runtime_context_missing' >&2
      return 78
    fi
    return 0
  fi
  python3 - "$control" "$task" "$attempt" <<'PY'
import os
import stat
import sys

flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
held = []
try:
    held.append(os.open(sys.argv[1], flags))
    for name in ("runtime-migration-intents", "t" + sys.argv[2]):
        held.append(os.open(name, flags, dir_fd=held[-1]))
        info = os.fstat(held[-1])
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("insecure intent directory")
    info = os.stat(sys.argv[3] + ".json", dir_fd=held[-1], follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("insecure intent")
except FileNotFoundError:
    sys.exit(0)
except (OSError, ValueError):
    print("FACTORY_ERROR=factory_runtime_pin_invalid", file=sys.stderr)
    sys.exit(78)
finally:
    for fd in reversed(held):
        os.close(fd)
print("FACTORY_ERROR=factory_runtime_pin_migration_pending", file=sys.stderr)
sys.exit(75)
PY
}

# Writer работает без task FD и отсоединяет свою сессию.
# Родитель допускает решение только после exact reply и выхода writer.
factory_darwin_commit_runtime_context() {
  [[ "${FACTORY_RUNTIME_CONTEXT_REQUIRED:-0}" == 1 ]] || return 0
  local control=$1 task=$2 attempt=$3 profile=$4 writer_pid rc=0 interrupted=0 output diagnostics
  local node=${GRIGDESK_SERVER_RUNTIME_NODE:-} script=${GRIGDESK_SERVER_RUNTIME_PIN_HELPER:-}
  [[ "$node" == /* && "$script" == /* ]] || return 78
  output=$(mktemp /private/tmp/grigdesk-pin.XXXXXX) || return 78
  diagnostics=$(mktemp /private/tmp/grigdesk-pin.XXXXXX) || {
    rm -f -- "$output"
    return 78
  }
  trap '(( interrupted != 0 )) || interrupted=143' TERM
  trap '(( interrupted != 0 )) || interrupted=130' INT
  (
    exec {V2_LOCK_FD}<&-
    exec python3 "$FACTORY_HOME/lib/darwin-decision-reader.py" \
      "$FACTORY_DARWIN_PROCESS_HELPER" "$FACTORY_DARWIN_SETSID" --host-context \
      "$node" "$script" commit-legacy "$task" "$attempt" "$profile" "$control"
  ) >"$output" 2>"$diagnostics" &
  writer_pid=$!
  exec 3<&-
  if (( interrupted == 0 )); then
    wait "$writer_pid" || rc=$?
  fi
  if (( interrupted != 0 )); then
    trap '' TERM INT
    kill -TERM "$writer_pid" 2>/dev/null || true
    wait "$writer_pid" 2>/dev/null || true
    rc=$interrupted
  elif (( rc == 0 )); then
    jq -e --arg task "$task" --arg attempt "$attempt" \
      '.format == 1 and .task == $task and .attempt == $attempt and .protocol == "route-v2"' \
      "$output" >/dev/null || rc=78
  else
    sed -n -E '/^FACTORY_ERROR=[a-z_]+$/p' "$diagnostics" >&2
  fi
  if (( interrupted != 0 )) && grep -qx 'FACTORY_ERROR=release_activity_unknown' "$diagnostics"; then
    printf '%s\n' 'FACTORY_ERROR=release_activity_unknown' >&2
    rc=78
  fi
  rm -f -- "$output" "$diagnostics"
  trap - TERM INT
  unset GRIGDESK_SERVER_RUNTIME_NODE GRIGDESK_SERVER_RUNTIME_PIN_HELPER
  return "$rc"
}
