#!/usr/bin/env bash
# Сегментированный журнал жизненного цикла одной неизменяемой попытки маршрута, принадлежащий хосту.
#
# Публичный API:
#   attempt_lifecycle_init_v2 TASK ATTEMPT_ID
#   attempt_lifecycle_append_v2 TASK ATTEMPT_ID EVENT_DRAFT_JSON
#   attempt_lifecycle_read_v2 TASK ATTEMPT_ID
#   attempt_lifecycle_validate_v2 TASK ATTEMPT_ID
#
# EVENT_DRAFT_JSON — один regular-файл владельца с точной общей оболочкой, кроме
# принадлежащих писателю полей sequence, previousEventHash и eventHash. Каждый ключ
# scoped-идентичности присутствует и содержит либо требуемую схемой идентичность, либо
# null; details — точный объект своего вида из lifecycle-event.schema.json. Успешное
# дописывание печатает принятый eventHash в нижнем регистре и один LF. Чтение печатает
# проверенный канонический NDJSON; init/validate ничего не печатают.
#
# Ротация сегментов выполняется внутри append. В бою по умолчанию 16 МиБ; значение
# FACTORY_LIFECYCLE_SEGMENT_BYTES допустимо только в диапазоне 65536..268435456
# (тесты могут принудительно задать меньше).
#
# Коды возврата:
#   0  успех
#   1  ошибка долговечного ввода-вывода файловой системы
#   2  некорректный аргумент вызывающего
#   3  lifecycle/attempt не инициализирован
#   73 конфликт стабильного eventId
#   74 восстанавливаемый неполный активный хвост (только операции чтения)
#   78 повреждение строгой схемы, цепочки или файловой системы

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/attempt-state.sh"

_attempt_lifecycle_schema_path() {
  local candidate canonical
  candidate=${FACTORY_ANALYTICS_LIFECYCLE_SCHEMA:-"$FACTORY_HOME/../schemas/analytics/lifecycle-event.schema.json"}
  [[ "$candidate" == /* && -f "$candidate" && ! -L "$candidate" ]] || return 78
  canonical=$(realpath -e -- "$candidate" 2>/dev/null) || return 78
  [[ -f "$canonical" && ! -L "$canonical" ]] || return 78
  printf '%s\n' "$canonical"
}

_attempt_lifecycle_attempt_dir() {
  local task attempt root dir canonical
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  root=$(attempt_state_v2_task_root "$task") || return
  dir="$root/attempts/$attempt"
  [[ -d "$dir" && ! -L "$dir" && -O "$dir" ]] || return 3
  canonical=$(realpath -e -- "$dir" 2>/dev/null) || return 78
  [[ "$canonical" == "$dir" ]] || return 78
  printf '%s\n' "$dir"
}

_attempt_lifecycle_python() {
  local schema
  schema=$(_attempt_lifecycle_schema_path) || return
  command -v python3 >/dev/null 2>&1 || return 78
  python3 "$FACTORY_HOME/lib/attempt-lifecycle-state.py" \
    --schema "$schema" \
    --segment-bytes "${FACTORY_LIFECYCLE_SEGMENT_BYTES:-16777216}" \
    "$@"
}

attempt_lifecycle_init_v2() {
  local task attempt dir
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  dir=$(_attempt_lifecycle_attempt_dir "$task" "$attempt") || return
  _attempt_lifecycle_python init "$dir" "t$task" "$attempt"
}

attempt_lifecycle_append_v2() {
  local task attempt draft dir
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  draft=${3:-}
  [[ -n "$draft" && -f "$draft" && ! -L "$draft" ]] || return 2
  dir=$(_attempt_lifecycle_attempt_dir "$task" "$attempt") || return
  _attempt_lifecycle_python append "$dir" "t$task" "$attempt" "$draft"
}

attempt_lifecycle_read_v2() {
  local task attempt dir
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  dir=$(_attempt_lifecycle_attempt_dir "$task" "$attempt") || return
  _attempt_lifecycle_python read "$dir" "t$task" "$attempt"
}

attempt_lifecycle_validate_v2() {
  local task attempt dir
  task=$(_attempt_state_task_id "${1:-}") || return
  attempt=$(_attempt_state_attempt_id "${2:-}") || return
  dir=$(_attempt_lifecycle_attempt_dir "$task" "$attempt") || return
  _attempt_lifecycle_python validate "$dir" "t$task" "$attempt"
}

# Помощник совместимости для общих golden-векторов shell/Node. Он намеренно работает с
# ограниченным подмножеством RFC 8785 в общем виде; lifecycle append применяет строгую схему.
attempt_lifecycle_canonical_v2() {
  local input=${1:-}
  [[ -n "$input" && -f "$input" && ! -L "$input" ]] || return 2
  _attempt_lifecycle_python canonical "$input"
}

attempt_lifecycle_event_hash_v2() {
  local input=${1:-}
  [[ -n "$input" && -f "$input" && ! -L "$input" ]] || return 2
  _attempt_lifecycle_python event-hash "$input"
}
