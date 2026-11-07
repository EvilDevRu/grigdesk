#!/usr/bin/env bash
# Ограниченный writer неслужебных полей вторичной проекции state/tNNNN.pipeline.
#   pipeline-set.sh <TASK> KEY VAL [KEY VAL ...]
# Topology, lifecycle, provenance и route statuses принадлежат host/run capability APIs.
set -uo pipefail

STATE_DIR="${STATE_DIR:-$HOME/.factory/state}"
FACTORY_HOME="${FACTORY_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck disable=SC1091
source "$FACTORY_HOME/lib/pipeline-store.sh"

TASK=${1:?Использование: pipeline-set.sh <TASK> KEY VAL [KEY VAL ...]}
shift
# Агенты зовут скрипт и как «<TASK>», и как «t<TASK>» (имя задачи они видят с префиксом в файлах).
# Без нормализации второй вариант создаёт реестр-призрак tt<TASK>.pipeline, отчёт этапа уходит
# в никуда, а движок считает этап неотчитавшимся и гоняет его заново.
TASK=${TASK#[tT]}
[[ "$TASK" =~ ^[1-9][0-9]{0,18}$ ]] || {
  echo "stale_run: invalid task id" >&2
  exit 73
}
PF="$STATE_DIR/t${TASK}.pipeline"
mkdir -p "$STATE_DIR"

# Terminal agent result принимается только через stage-result.sh с run capability.
# Разбираем именно пары KEY/VALUE: сырой просмотр argv пропускал CHECK=done и одновременно
# запрещал безобидное NOTE done, принимая любое слово `done` за terminal status.
guard_protocol_updates() {
  local token key value current base base_current protocol=0
  local -a args=("$@")
  local index=0

  grep -q '^RUN_PROTOCOL=2$' "$PF" 2>/dev/null && protocol=1
  while (( index < ${#args[@]} )); do
    token=${args[$index]}
    index=$((index + 1))
    if [[ "$token" == *=* ]]; then
      key=${token%%=*}
      value=${token#*=}
    else
      key=$token
      value=${args[$index]:-}
      (( index < ${#args[@]} )) && index=$((index + 1))
    fi
    [[ "$key" =~ ^[A-Z][A-Z0-9_]{0,127}$ ]] || return 2
    if reserved_control_key "$key"; then
      echo "stale_run: reserved key requires host control writer" >&2
      return 73
    fi
    (( protocol == 1 )) || continue
    current=$(awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' \
      "$PF" 2>/dev/null)
    base=${key%_COMMENT}
    base_current=""
    if [[ "$base" != "$key" ]]; then
      base_current=$(awk -F= -v key="$base" \
        '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$PF" 2>/dev/null)
    fi
    case "$current|$base_current" in
      pending\|*|running\|*|waiting\|*|approved\|*|rejected\|*|done\|*|failed\|*|skipped\|*|\
      *\|pending|*\|running|*\|waiting|*\|approved|*\|rejected|*\|done|*\|failed|*\|skipped)
        echo "stale_run: route status/comment requires run or host control writer" >&2
        return 73 ;;
    esac
  done
}

reserved_control_key() {
  local key=$1 base
  case "$key" in
    RUN_PROTOCOL|CATALOG_PROTOCOL|PROFILE|ROUTE|ROUTE_BY|ATTEMPT_ID|ROUTE_HASH|RESULT|\
    WORKSPACE_MODE|STAND_OWNERSHIP|ORCH_PID|WF_STATUS|STALLED_HUMAN|DELIVERY_MODE|\
    FE_PORT|API_PORT|SB_K|CONTAINER|SIZE|TRIVIAL_ESCALATED|\
    PLAN_DECISION|CAUSE_DECISION|ACCEPTANCE_DECISION|*_DECISION_COMMENT|\
    ACTIVE_RUN_*|ACTIVE_EPOCH_*|RUNNER_*|MODEL_*|CATALOG_*|PLAN_LEVEL_*|FANOUT_*|DENIALS_*|\
    REPO_*|*_AT|*_FAILS)
      return 0 ;;
    *_COMMENT)
      base=${key%_COMMENT}
      reserved_control_key "$base"
      return ;;
    *) return 1 ;;
  esac
}

# Публичный writer не владеет topology/lifecycle/provenance. Эти поля пишет
# только host/control path (`set_st` → run_state_control_update), а terminal и
# emitted progress — run-scoped capability APIs.
if [[ "${1:-}" == --init ]]; then
  echo "stale_run: route registry init requires host control writer" >&2
  exit 73
fi

# Архив и отсутствующая задача read-only: публичный writer не создаёт ghost registry
# и не «воскрешает» завершённую попытку. Проверка и update живут под тем же task lock.
pipeline_lock_acquire "$TASK" lock_fd || exit $?
trap 'pipeline_lock_release "$lock_fd"' EXIT
if [[ ! -f "$PF" || -L "$PF" ]]; then
  echo "stale_run: active route registry required" >&2
  exit 73
fi
guard_protocol_updates "$@" || exit $?

# Помимо значения одним atomic update пишем его телеметрию. Пары сначала целиком
# разбираются в памяти: читатель не увидит половину multi-key изменения.
declare -a updates=()
while [[ $# -ge 1 ]]; do
  kv="$1"; shift
  if [[ "$kv" == *=* ]]; then
    key=${kv%%=*}
    val=${kv#*=}
  else
    val=${1-}; shift 2>/dev/null || true   # пустое значение допустимо (очистка ключа)
    key=$kv
  fi
  val=${val//$'\n'/ }
  updates+=("$key" "$val")
  case "$val" in
    done|failed|waiting|approved|rejected|skipped|running)
      updates+=("${key}_AT" "$(date '+%F %T')") ;;
    pending)
      if grep -q "^${key}_AT=" "$PF" 2>/dev/null; then
        updates+=("${key}_AT" "")
      fi ;;
  esac
  if [[ "$val" == failed ]]; then
    fails=$(awk -F= -v key="${key}_FAILS" '$1 == key { value=$2 } END { print value }' \
      "$PF" 2>/dev/null)
    [[ "$fails" =~ ^[0-9]+$ ]] || fails=0
    updates+=("${key}_FAILS" "$((fails + 1))")
  fi
done
(( ${#updates[@]} > 0 )) || exit 2
pipeline_store_update_unlocked "$TASK" "${updates[@]}" || exit $?
awk 'index($0, "=") { print; if (++shown == 20) exit }' "$PF"
