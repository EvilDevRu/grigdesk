#!/usr/bin/env bash
# Долговечный CAS-источник истины для цепочки возобновления нативной сессии провайдера.
#
# Публичный API принимает строгие JSON-файлы запросов, определённые в
# schemas/analytics/provider-lineage.schema.json:
#   provider_lineage_initialize_advanced_v1 REQUEST_JSON
#   provider_lineage_reserve_v1 REQUEST_JSON
#   provider_lineage_mark_started_v1 REQUEST_JSON
#   provider_lineage_advance_v1 REQUEST_JSON
#   provider_lineage_cancel_v1 REQUEST_JSON
#   provider_lineage_block_v1 REQUEST_JSON
#   provider_lineage_read_v1 PROVIDER THREAD_ID
#   provider_lineage_validate_v1 PROVIDER THREAD_ID
#
# Коды возврата:
#   2  некорректный аргумент вызывающего
#   3  lineage не существует
#   73 та же идентичность перехода с другой полезной нагрузкой
#   75 конфликт CAS/scope или уже использованный предшественник
#   78 повреждение строгой схемы, смешанных писателей или файловой системы

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/run-state.sh"

_provider_lineage_schema_path() {
  local candidate canonical
  candidate=${FACTORY_PROVIDER_LINEAGE_SCHEMA:-"$FACTORY_HOME/../schemas/analytics/provider-lineage.schema.json"}
  [[ "$candidate" == /* && -f "$candidate" && ! -L "$candidate" ]] || return 78
  canonical=$(realpath -e -- "$candidate" 2>/dev/null) || return 78
  [[ -f "$canonical" && ! -L "$canonical" ]] || return 78
  printf '%s\n' "$canonical"
}

_provider_lineage_control_root() {
  local root canonical
  root=$(factory_control_root) || return
  [[ -d "$root" && ! -L "$root" && -O "$root" ]] || return 3
  canonical=$(realpath -e -- "$root" 2>/dev/null) || return 78
  [[ "$canonical" == "$root" ]] || return 78
  chmod 700 -- "$root" 2>/dev/null || return 78
  printf '%s\n' "$root"
}

_provider_lineage_python() {
  local schema
  schema=$(_provider_lineage_schema_path) || return
  command -v python3 >/dev/null 2>&1 || return 78
  python3 "$FACTORY_HOME/lib/provider-lineage-state.py" --schema "$schema" "$@"
}

_provider_lineage_request() {
  local operation=$1 request=${2:-} root
  [[ -n "$request" && -f "$request" && ! -L "$request" ]] || return 2
  root=$(_provider_lineage_control_root) || return
  _provider_lineage_python "$operation" "$root" "$request"
}

provider_lineage_initialize_advanced_v1() {
  _provider_lineage_request initialize "${1:-}"
}

provider_lineage_reserve_v1() {
  _provider_lineage_request reserve "${1:-}"
}

provider_lineage_mark_started_v1() {
  _provider_lineage_request started "${1:-}"
}

provider_lineage_advance_v1() {
  _provider_lineage_request advance "${1:-}"
}

provider_lineage_cancel_v1() {
  _provider_lineage_request cancel "${1:-}"
}

provider_lineage_block_v1() {
  _provider_lineage_request block "${1:-}"
}

provider_lineage_read_v1() {
  local provider=${1:-} thread=${2:-} root
  [[ -n "$provider" && -n "$thread" ]] || return 2
  root=$(_provider_lineage_control_root) || return
  _provider_lineage_python read "$root" "$provider" "$thread"
}

provider_lineage_validate_v1() {
  local provider=${1:-} thread=${2:-} root
  [[ -n "$provider" && -n "$thread" ]] || return 2
  root=$(_provider_lineage_control_root) || return
  _provider_lineage_python validate "$root" "$provider" "$thread"
}

provider_lineage_scope_canonical_v1() {
  local provider=${1:-} thread=${2:-}
  [[ -n "$provider" && -n "$thread" ]] || return 2
  _provider_lineage_python scope-canonical "$provider" "$thread"
}

provider_lineage_scope_hash_v1() {
  local provider=${1:-} thread=${2:-}
  [[ -n "$provider" && -n "$thread" ]] || return 2
  _provider_lineage_python scope-hash "$provider" "$thread"
}

provider_lineage_record_path_v1() {
  local provider=${1:-} thread=${2:-} root hash
  [[ -n "$provider" && -n "$thread" ]] || return 2
  root=$(_provider_lineage_control_root) || return
  hash=$(provider_lineage_scope_hash_v1 "$provider" "$thread") || return
  printf '%s/protocol-v2/provider-lineage/schema-1/%s/%s.json\n' "$root" "$provider" "$hash"
}
