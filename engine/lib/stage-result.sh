#!/usr/bin/env bash
set -uo pipefail

FACTORY_HOME="$(cd "$(dirname "$0")/.." && pwd)"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/status-request.sh"

task="" stage="" run_id="" epoch="" result="" comment="" failure_owner="" stage_flags=0
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
    # Граница этапа цикла: ведущий принимает этап и передаёт следующий. Доступна только
    # ведущему (подсказку роли ставит диспетчер); честность границы проверяет коммит.
    --next-stage) findings+=("stage:next"); stage_flags=1; shift ;;
    --stage-closed) findings+=("stage-closed:${2:-}"); stage_flags=1; shift 2 ;;
    --stage-summary) findings+=("stage-summary:${2:-}"); stage_flags=1; shift 2 ;;
    *)
      if [[ -z "$result" ]]; then result=$1; else comment="${comment:+$comment }$1"; fi
      shift ;;
  esac
done
[[ -n "$task" && -n "$stage" && -n "$run_id" && -n "$epoch" && -n "$result" ]] || exit 2

if (( stage_flags )) && [[ "${FACTORY_LOOP_ROLE:-}" != lead ]]; then
  printf '%s\n' \
    'stage-result: граница этапа (--next-stage) доступна только ведущему узлу цикла' >&2
  exit 2
fi

# Отказ, в котором не осталось ни одного блокирующего замечания, — это не отказ.
# Проверяющий сам решил, что всё найденное можно отложить, и держать из-за этого
# маршрут не за что: исход выпрямляем в done, находки едут отложенным хвостом.
# Иначе такой вердикт разворачивал бы сборку по замечаниям, чинить которые никто
# не просил, и упирался бы в no-progress ровно потому, что чинить нечего.
if [[ "$result" == failed && ${#findings[@]} -gt 0 ]]; then
  has_blocking=0
  for raw in "${findings[@]}"; do
    case "$raw" in
      deferred:*|anchor:*|reviewed:*|stage:*|stage-closed:*|stage-summary:*) ;;
      *) has_blocking=1; break ;;
    esac
  done
  if [[ $has_blocking -eq 0 ]]; then
    result=done
  fi
fi

verdict_b64=$(run_state_verdict_encode "$result" "$failure_owner" "${findings[@]}") || exit

# Предпроверка сдачи профиля — до записи результата, пока агент жив. Хост после
# раннера проверит то же самое доверенно (evidence-хук), но тогда исправлять уже
# некому: узел встаёт, а причину носит человек. Здесь та же проверка отдаёт причину
# прямо в вывод команды, и агент чинит сдачу в том же заходе. Путь назначает движок
# (`FACTORY_STAGE_RESULT_CHECK`), сам скрипт — профиля; отсутствие или недоступность
# файла не блокирует сдачу: доверенная проверка всё равно впереди.
if [[ "$result" != failed && -n "${FACTORY_STAGE_RESULT_CHECK:-}" ]]; then
  if [[ -f "$FACTORY_STAGE_RESULT_CHECK" && -x "$FACTORY_STAGE_RESULT_CHECK" ]]; then
    check_output=$("$FACTORY_STAGE_RESULT_CHECK" "$task" "$stage" "$result" 2>&1)
    check_rc=$?
    if (( check_rc != 0 )); then
      printf 'stage-result: сдача %s отклонена предпроверкой профиля (код %s) — результат НЕ записан.\n' \
        "$result" "$check_rc" >&2
      [[ -z "$check_output" ]] || printf '%s\n' "$check_output" >&2
      printf 'Исправь названное и вызови stage-result снова.\n' >&2
      exit 65
    fi
  else
    printf 'stage-result: предпроверка профиля недоступна (%s) — сдача идёт без неё.\n' \
      "$FACTORY_STAGE_RESULT_CHECK" >&2
  fi
fi

status_fd=${FACTORY_STATUS_FD:-7}
if [[ "$status_fd" =~ ^[0-9]+$ && -r "/proc/self/fd/$status_fd" ]]; then
  token=$(head -1 "/proc/self/fd/$status_fd") || exit 74
  run_state_apply_result \
    "$task" "$stage" "$run_id" "$epoch" "$token" "$result" "$comment" "$verdict_b64"
else
  status_request_result \
    "$task" "$stage" "$run_id" "$epoch" "$result" "$comment" "$verdict_b64"
fi
