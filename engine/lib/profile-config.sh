#!/usr/bin/env bash

_profile_config_key_allowed() {
  case "${1:-}" in
    RUNNERS_SCHEMA|CONFIG_REVISION|RUNNERS_COVERAGE|PROJECT_RUNNER_PRIMARY|PROJECT_RUNNER_FAILOVER)
      return 0 ;;
    STAGE_*_PRIMARY|STAGE_*_FAILOVER|MODEL_*|RUNNER_*_AUTH_PROFILE)
      [[ "$1" =~ ^[A-Z][A-Z0-9_]*$ ]] ;;
    *) return 1 ;;
  esac
}

_profile_config_value_allowed() {
  [[ "${1:-}" =~ ^[A-Za-z0-9._,:/@=+-]*$ ]]
}

profile_config_validate() {
  local file=${1:?config file} line key value schema revision primary failover
  declare -A seen=()
  [[ -f "$file" ]] || return 2
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || return 2
    key=${line%%=*}; value=${line#*=}
    _profile_config_key_allowed "$key" || return 2
    _profile_config_value_allowed "$value" || return 2
    [[ -z "${seen[$key]:-}" ]] || return 2
    seen["$key"]=1
  done <"$file"
  schema=$(profile_config_get "$file" RUNNERS_SCHEMA)
  revision=$(profile_config_get "$file" CONFIG_REVISION)
  primary=$(profile_config_get "$file" PROJECT_RUNNER_PRIMARY)
  failover=$(profile_config_get "$file" PROJECT_RUNNER_FAILOVER)
  [[ "$schema" == 1 && "$revision" =~ ^[0-9]+$ &&
     "$primary" =~ ^[a-z][a-z0-9_-]*$ ]] || return 2
  [[ -z "$failover" ||
     "$failover" =~ ^[a-z][a-z0-9_-]*(,[a-z][a-z0-9_-]*)*$ ]] || return 2
}

profile_config_get() {
  local file=${1:?config file} key=${2:?key}
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); value=$0 } END { print value }' \
    "$file" 2>/dev/null
}

# Модельная политика хранит причины решений рядом с ключами. CAS-изменение одного
# значения сохраняет эти комментарии и порядок существующих строк; новые ключи идут в хвост.
_profile_config_render() {
  local output=$1 source=${3:-} line key
  local -n values_ref=$2
  declare -A written=()
  {
    if [[ -f "$source" ]]; then
      while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ -z "$line" || "$line" == \#* ]]; then
          printf '%s\n' "$line"
        else
          key=${line%%=*}
          printf '%s=%s\n' "$key" "${values_ref[$key]}"
          written["$key"]=1
        fi
      done <"$source"
    else
      printf 'RUNNERS_SCHEMA=%s\n' "${values_ref[RUNNERS_SCHEMA]}"
      printf 'CONFIG_REVISION=%s\n' "${values_ref[CONFIG_REVISION]}"
      written[RUNNERS_SCHEMA]=1
      written[CONFIG_REVISION]=1
    fi
    while IFS= read -r key; do
      [[ "${written[$key]:-}" == 1 ]] && continue
      printf '%s=%s\n' "$key" "${values_ref[$key]}"
    done < <(printf '%s\n' "${!values_ref[@]}" | sort)
  } >"$output"
}

profile_config_write() {
  local file=${1:?config file} expected_revision=${2:?expected revision}; shift 2
  (( $# % 2 == 0 )) || return 2
  mkdir -p "$(dirname "$file")"
  local lock_fd current_schema current_revision key value tmp rc=0
  exec {lock_fd}>"${file}.lock"
  flock "$lock_fd" || return 1
  if [[ -f "$file" ]]; then
    current_schema=$(profile_config_get "$file" RUNNERS_SCHEMA)
    if [[ "$current_schema" != 1 ]]; then
      flock -u "$lock_fd"; eval "exec ${lock_fd}>&-"
      return 78
    fi
    profile_config_validate "$file" || {
      flock -u "$lock_fd"; eval "exec ${lock_fd}>&-"
      return 2
    }
    current_revision=$(profile_config_get "$file" CONFIG_REVISION)
  else
    current_revision=0
  fi
  if [[ "$current_revision" != "$expected_revision" ]]; then
    flock -u "$lock_fd"; eval "exec ${lock_fd}>&-"
    return 72
  fi

  declare -A values=()
  if [[ -f "$file" ]]; then
    while IFS='=' read -r key value; do
      [[ -n "$key" && "$key" != \#* ]] && values["$key"]=$value
    done <"$file"
  fi
  values[RUNNERS_SCHEMA]=1
  values[CONFIG_REVISION]=$((current_revision + 1))
  while (( $# >= 2 )); do
    key=$1; value=$2; shift 2
    _profile_config_key_allowed "$key" && _profile_config_value_allowed "$value" || {
      rc=2; break
    }
    [[ "$key" != RUNNERS_SCHEMA && "$key" != CONFIG_REVISION ]] || {
      rc=2; break
    }
    values["$key"]=$value
  done
  if (( rc == 0 )); then
    tmp=$(mktemp "$(dirname "$file")/.runners.XXXXXX")
    _profile_config_render "$tmp" values "$file"
    sync -f "$tmp" 2>/dev/null || true
    if [[ "${FACTORY_TEST_CRASH_BEFORE_RENAME:-0}" == 1 ]]; then
      rm -f -- "$tmp"
      rc=99
    else
      mv -f -- "$tmp" "$file"
      [[ "${FACTORY_TEST_CRASH_AFTER_RENAME:-0}" == 1 ]] && rc=98
    fi
  fi
  flock -u "$lock_fd"
  eval "exec ${lock_fd}>&-"
  return "$rc"
}

profile_config_create() {
  local file=${1:?config file} primary=${2:?primary} failover=${3:-}
  [[ "$primary" =~ ^[a-z][a-z0-9_-]*$ ]] || return 2
  [[ -z "$failover" ||
     "$failover" =~ ^[a-z][a-z0-9_-]*(,[a-z][a-z0-9_-]*)*$ ]] || return 2
  [[ ! -e "$file" ]] || return 73
  profile_config_write "$file" 0 PROJECT_RUNNER_PRIMARY "$primary" \
    PROJECT_RUNNER_FAILOVER "$failover" RUNNERS_COVERAGE required || return
  profile_config_validate "$file"
}
