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
      claude|claude-*|codex|codex-*|kimi|kimi-*|dsh|dsh-*|deepseek|deepseek-*|glm|glm-*|gemini|gemini-*|\
      curl|wget|ssh|scp|nc|ncat)
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

# Закрытый descriptor готовит сервер: выбранная внешним терминалом копия, её identity,
# PATH и только безопасные переменные. Полный env и ключи сюда не попадают.
factory_external_parse() {
  local provider=${1:?provider}
  local descriptor=${FACTORY_EXTERNAL_CLI_DESCRIPTOR:-}
  FACTORY_EXTERNAL_BIN=""
  FACTORY_EXTERNAL_IDENTITY=""
  FACTORY_EXTERNAL_PROVIDER_ID=""
  FACTORY_EXTERNAL_RESOURCE_KEY=""
  FACTORY_EXTERNAL_LEASE_DIR=""
  FACTORY_EXTERNAL_ENV=()
  FACTORY_EXTERNAL_LEASE=()
  [[ -n "$descriptor" && -r "$descriptor" ]] || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  local -a values=()
  mapfile -d '' -t values < <(
    python3 - "$descriptor" "$provider" 2>/dev/null <<'PYTHON'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as source:
        document = json.load(source)
except (OSError, ValueError):
    raise SystemExit(3)

providers = document.get("providers") if isinstance(document, dict) else None
entry = providers.get(sys.argv[2]) if isinstance(providers, dict) else None
if not isinstance(entry, dict):
    raise SystemExit(3)

lease = entry.get("leaseCommand")
if not isinstance(lease, list) or not lease or not all(isinstance(item, str) for item in lease):
    raise SystemExit(3)

environment = entry.get("env")


def valid_key(key):
    return (isinstance(key, str) and key and not key[0].isdigit()
            and all(character.isalnum() or character == "_" for character in key))


pairs = [f"{key}={value}" for key, value in (environment or {}).items()
         if valid_key(key) and isinstance(value, str) and "\0" not in value]
fields = [
    entry.get("bin"), entry.get("identity"), entry.get("providerId"),
    entry.get("resourceKey"), entry.get("leaseDirectory"), str(len(pairs)),
    *pairs, str(len(lease)), *lease,
]
out = sys.stdout.buffer
for field in fields:
    out.write(str(field).encode("utf-8") + b"\0")
PYTHON
  )
  ((${#values[@]} >= 7)) || return 1
  local env_count=${values[5]} lease_count index=6
  [[ "$env_count" =~ ^[0-9]+$ ]] || return 1
  FACTORY_EXTERNAL_BIN=${values[0]}
  FACTORY_EXTERNAL_IDENTITY=${values[1]}
  FACTORY_EXTERNAL_PROVIDER_ID=${values[2]}
  FACTORY_EXTERNAL_RESOURCE_KEY=${values[3]}
  FACTORY_EXTERNAL_LEASE_DIR=${values[4]}
  while ((index < 6 + env_count)); do
    FACTORY_EXTERNAL_ENV+=("${values[index]}")
    index=$((index + 1))
  done
  lease_count=${values[index]:-}
  index=$((index + 1))
  [[ "$lease_count" =~ ^[0-9]+$ ]] || return 1
  while ((index < 6 + env_count + 1 + lease_count)); do
    FACTORY_EXTERNAL_LEASE+=("${values[index]}")
    index=$((index + 1))
  done
  [[ "$FACTORY_EXTERNAL_BIN" == /* && -x "$FACTORY_EXTERNAL_BIN" ]] || return 1
  [[ "$FACTORY_EXTERNAL_IDENTITY" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$FACTORY_EXTERNAL_PROVIDER_ID" == "$provider" ]] || return 1
  [[ "$FACTORY_EXTERNAL_RESOURCE_KEY" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$FACTORY_EXTERNAL_LEASE_DIR" == /* ]] || return 1
  return 0
}

# Без descriptor-а сохраняется прежний поиск по PATH; внешний stage не ломается
# на установке, которую GrigDesk ещё не подтвердил.
factory_external_bin() {
  local provider=${1:?provider} default=${2:?default}
  if factory_external_parse "$provider"; then
    printf '%s\n' "$FACTORY_EXTERNAL_BIN"
  else
    printf '%s\n' "$default"
  fi
}

# Probe и короткие запросы тоже участвуют в занятости: helper держит reader.
factory_external_exec() {
  local provider=${1:?provider} default=${2:?default}
  shift 2
  if ! factory_external_parse "$provider"; then
    factory_exec provider "$default" "$@"
    return $?
  fi
  factory_exec_check provider "$FACTORY_EXTERNAL_BIN" || return $?
  local -a prefix=()
  ((${#FACTORY_EXTERNAL_ENV[@]})) && prefix=(env "${FACTORY_EXTERNAL_ENV[@]}")
  if ((${#FACTORY_EXTERNAL_LEASE[@]})); then
    "${prefix[@]}" "${FACTORY_EXTERNAL_LEASE[@]}" \
      --identity "$FACTORY_EXTERNAL_IDENTITY" \
      --lease-dir "$FACTORY_EXTERNAL_LEASE_DIR" \
      --provider "$FACTORY_EXTERNAL_PROVIDER_ID" \
      --resource "$FACTORY_EXTERNAL_RESOURCE_KEY" \
      -- "$FACTORY_EXTERNAL_BIN" "$@"
  else
    "${prefix[@]}" "$FACTORY_EXTERNAL_BIN" "$@"
  fi
}

# Возвращает массив готовой команды, чтобы внешний timeout оставался снаружи.
# SIGTERM тогда получает helper, а он завершает собственную сессию CLI.
# Аргументы после default НЕ включают имя CLI: оно ставится первым здесь —
# дескрипторный бинарь при валидном descriptor-е, иначе default. Сдвоенное имя
# доходит до парсера CLI: Codex его молча проглатывает, Kimi падает с
# «unknown command» до модели (инцидент 07.11.2026).
factory_external_launch() {
  local provider=${1:?provider} default=${2:?default}
  shift 2
  FACTORY_EXTERNAL_LAUNCH=("$default" "$@")
  factory_external_parse "$provider" || return 0
  factory_exec_check provider "$FACTORY_EXTERNAL_BIN" || return $?
  local -a prefix=()
  ((${#FACTORY_EXTERNAL_ENV[@]})) && prefix=(env "${FACTORY_EXTERNAL_ENV[@]}")
  if ((${#FACTORY_EXTERNAL_LEASE[@]})); then
    FACTORY_EXTERNAL_LAUNCH=("${prefix[@]}" "${FACTORY_EXTERNAL_LEASE[@]}" \
      --identity "$FACTORY_EXTERNAL_IDENTITY" \
      --lease-dir "$FACTORY_EXTERNAL_LEASE_DIR" \
      --provider "$FACTORY_EXTERNAL_PROVIDER_ID" \
      --resource "$FACTORY_EXTERNAL_RESOURCE_KEY" \
      -- "$FACTORY_EXTERNAL_BIN" "$@")
  else
    FACTORY_EXTERNAL_LAUNCH=("${prefix[@]}" "$FACTORY_EXTERNAL_BIN" "$@")
  fi
  return 0
}
