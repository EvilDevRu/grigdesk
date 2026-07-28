#!/usr/bin/env bash
# Сторож фабрики: поднимает конвейеры, у которых умер демон.
#
# Работает ТОЛЬКО когда включён тумблером на дашборде. Причина (решение пользователя):
# человек не всегда за компьютером, и фабрика не должна крутиться в его отсутствие.
# Флаг включения лежит в XDG_RUNTIME_DIR (tmpfs) — он ИСЧЕЗАЕТ при перезагрузке,
# поэтому после ребута сторож спит, даже если таймер включён. Это и есть требование
# «после ребута ничего не стартует само», но без вечного отключения сторожа.
set -uo pipefail
STATE_DIR="${FACTORY_STATE:-$HOME/.factory/state}"
FACTORY_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLAG="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/factory-watchdog.on"
MAX_RESTARTS=5     # больше — значит конвейер падает не случайно, и его должен смотреть человек
MAX_IDLE_H=6       # задача без движения дольше этого — заброшенная, поднимать её без спроса нельзя

[[ -f "$FLAG" ]] || exit 0

_set() { STATE_DIR="$STATE_DIR" bash "$FACTORY_HOME/lib/pipeline-set.sh" "$@" >/dev/null; }
_log() { echo "$(date '+%F %T') [t${1}] сторож: ${*:2}" >>"$STATE_DIR/logs/t${1}.stages.log"; }

for PF in "$STATE_DIR"/t*.pipeline; do
  [[ -f "$PF" ]] || continue
  TASK=$(basename "$PF" .pipeline); TASK=${TASK#t}

  grep -q '^RETRO=done' "$PF" && { _set "$TASK" NEEDS_RUN 0; continue; }
  grep -q '^WF_STATUS=running' "$PF" || { _set "$TASK" NEEDS_RUN 0; continue; }

  # На воротах ждём ЧЕЛОВЕКА: поднимать нечего, решение принимает он кнопкой
  if grep -qE '^GATE_[A-Z_]+=waiting' "$PF"; then
    _set "$TASK" NEEDS_RUN 0; continue
  fi

  # Живой демон? ORCH_PID врёт (перезапуски, устаревшие записи), поэтому вторая проверка — по процессу
  PID=$(grep '^ORCH_PID=' "$PF" | cut -d= -f2 || true)
  if { [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; } || pgrep -f "bin/factory $TASK " >/dev/null 2>&1; then
    _set "$TASK" NEEDS_RUN 0; continue
  fi

  # Дальше: демон мёртв, задача не на воротах и не завершена — конвейер стоит мёртвым.
  PROFILE=$(grep '^PROFILE=' "$PF" | cut -d= -f2 || true)
  ROUTE=$(grep '^ROUTE=' "$PF" | cut -d= -f2 || true)
  [[ -n "$PROFILE" ]] || { _set "$TASK" NEEDS_RUN 1; continue; }   # без профиля поднимать нечем

  # Заброшенная задача: реестр не менялся часами. Сторож нужен для «умер только что, подними
  # обратно», а не для воскрешения того, что человек оставил намеренно (у задач других проектов
  # и старых прогонов свои причины стоять). Такие только помечаем.
  IDLE_S=$(( $(date +%s) - $(stat -c %Y "$PF" 2>/dev/null || echo 0) ))
  if (( IDLE_S > MAX_IDLE_H * 3600 )); then
    _set "$TASK" NEEDS_RUN 1
    continue
  fi

  N=$(grep '^WATCHDOG_RESTARTS=' "$PF" | cut -d= -f2 || true); N=${N:-0}
  if (( N >= MAX_RESTARTS )); then
    # Повторяющаяся смерть — это не сбой, а симптом. Тихо перезапускать дальше значит
    # жечь время и деньги на этап, который всё равно не проходит.
    _set "$TASK" NEEDS_RUN 1 STALLED_HUMAN 1
    _log "$TASK" "перезапусков $N (лимит $MAX_RESTARTS) — дальше нужен человек"
    continue
  fi

  # Этап, на котором оборвались: его работа потеряна, движок начнёт его заново
  # WF_STATUS=running — это статус ВСЕЙ задачи, а не этап; без исключения он выдаётся за этап
  STAGE=$(grep -E '^[A-Z_]+=running$' "$PF" | grep -v '^WF_STATUS=' | head -1 | cut -d= -f1)
  _set "$TASK" WATCHDOG_RESTARTS "$((N + 1))" NEEDS_RUN 0
  _log "$TASK" "демон мёртв на этапе ${STAGE:-?} — поднимаю (перезапуск $((N + 1))/$MAX_RESTARTS)"
  "$FACTORY_HOME/bin/factory" "$TASK" resume --profile "$PROFILE" ${ROUTE:+--route "$ROUTE"} \
    >>"$STATE_DIR/logs/t${TASK}.stages.log" 2>&1
done
