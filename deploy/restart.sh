#!/usr/bin/env bash
# Перезапуск сервера GrigDesk без конфликтов порта (EADDRINUSE):
# гасим процессы на порту, ЖДЁМ освобождения, только потом стартуем новый.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Машинные настройки — из .env папки данных, как у bin/grigdesk-ctl и systemd-юнита. Раньше путь к
# venv распознавания был прописан прямо здесь, и работа диктовки зависела от способа запуска:
# поднятый этим скриптом GrigDesk распознавал, поднятый systemd падал со spawn ... ENOENT.
source "$ROOT/deploy/lib/runtime-env.sh"
grigdesk_add_cli_paths
grigdesk_require_migrated "$ROOT"
grigdesk_load_runtime_env "$ROOT"
DATA_HOME=$(grigdesk_data_home) || exit 1
LOG="${GRIGDESK_EFFECTIVE_LOG:-$DATA_HOME/state/grigdesk-server.log}"
PORT="$GRIGDESK_EFFECTIVE_PORT"
grigdesk_server_command "$ROOT"

# Потребитель труб владеет ротацией: сервер больше не держит fd старого архива.
# В готовом комплекте используется собранный helper и собственный Node.
grigdesk_require_node
LOG_RUNNER="$ROOT/server/scripts/runLoggedServer.mts"
if [[ -f "$ROOT/release.json" ]]; then
  LOG_RUNNER="$ROOT/server/runtime/helpers/run-logged-server.mjs"
fi

listening() { ss -tln 2>/dev/null | grep -q ":$1 "; }
busy() { listening "$PORT"; }

# Все PID'ы, слушающие порт приложения.
pids=$(ss -tlnp 2>/dev/null | grep -E ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
if [ -n "$pids" ]; then
  echo "гашу: $pids"
  # SIGTERM запускает в сервере слив ходов; ждём выхода процессов дольше его бюджета
  # (GRIGDESK_SHUTDOWN_TIMEOUT_MS, 30 с): порт освобождается раньше, чем отработают хуки
  # остановки, и новый сервер иначе упёрся бы в блокировку папки данных.
  grigdesk_stop_pids 45 $pids
fi
if busy; then
  listening "$PORT" && echo "порт :$PORT всё ещё занят — не стартую" >&2
  exit 1
fi

( umask 077; mkdir -p "$(dirname "$LOG")" )
cd "$ROOT"
setsid nohup "${_grigdesk_packaged_node:-node}" "$LOG_RUNNER" \
  "$LOG" "${GRIGDESK_SERVER_COMMAND[@]}" </dev/null >/dev/null 2>&1 &
disown

# Живость проверяем по /api/auth/state: он публичный (нужен экрану входа), а /api/health
# закрыт гардом авторизации — по нему скрипт всегда решал бы, что сервер не поднялся.
for _ in $(seq 1 50); do
  if curl -sf "http://localhost:$PORT/api/auth/state" >/dev/null 2>&1; then
    echo "GrigDesk поднят на :$PORT · лог: $LOG"
    exit 0
  fi
  sleep 0.2
done
echo "сервер не поднялся за 10с — смотри $LOG" >&2
exit 1
