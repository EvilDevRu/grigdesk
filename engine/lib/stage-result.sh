#!/usr/bin/env bash
set -uo pipefail

FACTORY_HOME="$(cd "$(dirname "$0")/.." && pwd)"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/status-request.sh"

task="" stage="" run_id="" epoch="" result="" comment="" failure_owner=""
declare -a findings=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) task=${2:-}; shift 2 ;;
    --stage) stage=${2:-}; shift 2 ;;
    --run-id) run_id=${2:-}; shift 2 ;;
    --epoch) epoch=${2:-}; shift 2 ;;
    --failure-owner) failure_owner=${2:-}; shift 2 ;;
    --finding) findings+=("${2:-}"); shift 2 ;;
    # Отложенная находка: дефект настоящий, но вне цели задачи. Возврата в сборку
    # не вызывает и уезжает хвостом на ворота приёмки.
    --finding-deferred) findings+=("deferred:${2:-}"); shift 2 ;;
    # Якорь замечания (id=путь) и объявленный охват прохода (путь) едут тем же
    # списком под префиксом: разбирает их run_state_verdict_encode.
    --finding-anchor) findings+=("anchor:${2:-}"); shift 2 ;;
    --reviewed) findings+=("reviewed:${2:-}"); shift 2 ;;
    *)
      if [[ -z "$result" ]]; then result=$1; else comment="${comment:+$comment }$1"; fi
      shift ;;
  esac
done
[[ -n "$task" && -n "$stage" && -n "$run_id" && -n "$epoch" && -n "$result" ]] || exit 2

# Отказ, в котором не осталось ни одного блокирующего замечания, — это не отказ.
# Проверяющий сам решил, что всё найденное можно отложить, и держать из-за этого
# маршрут не за что: исход выпрямляем в done, находки едут отложенным хвостом.
# Иначе такой вердикт разворачивал бы сборку по замечаниям, чинить которые никто
# не просил, и упирался бы в no-progress ровно потому, что чинить нечего.
if [[ "$result" == failed && ${#findings[@]} -gt 0 ]]; then
  has_blocking=0
  for raw in "${findings[@]}"; do
    case "$raw" in
      deferred:*|anchor:*|reviewed:*) ;;
      *) has_blocking=1; break ;;
    esac
  done
  if [[ $has_blocking -eq 0 ]]; then
    result=done
  fi
fi

verdict_b64=$(run_state_verdict_encode "$result" "$failure_owner" "${findings[@]}") || exit

status_fd=${FACTORY_STATUS_FD:-7}
if [[ "$status_fd" =~ ^[0-9]+$ && -r "/proc/self/fd/$status_fd" ]]; then
  token=$(head -1 "/proc/self/fd/$status_fd") || exit 74
  run_state_apply_result \
    "$task" "$stage" "$run_id" "$epoch" "$token" "$result" "$comment" "$verdict_b64"
else
  status_request_result \
    "$task" "$stage" "$run_id" "$epoch" "$result" "$comment" "$verdict_b64"
fi
