#!/usr/bin/env bash
# Перезапуск сервера кокпита без конфликтов порта (EADDRINUSE):
# гасим процессы на порту, ЖДЁМ освобождения, только потом стартуем новый.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# node нужен и серверу, и безопасному чтению .env из папки данных.
if ! command -v node >/dev/null 2>&1; then
  echo "node не найден в PATH" >&2
  exit 1
fi

# Машинные настройки — из .env папки данных, как у bin/cockpit и systemd-юнита. Раньше путь к
# venv распознавания был прописан прямо здесь, и работа диктовки зависела от способа запуска:
# поднятый этим скриптом кокпит распознавал, поднятый systemd падал со spawn ... ENOENT.
source "$ROOT/deploy/lib/runtime-env.sh"
cockpit_add_cli_paths
cockpit_require_migrated "$ROOT"
cockpit_load_runtime_env "$ROOT"
DATA_HOME=$(cockpit_data_home) || exit 1
LOG="${COCKPIT_EFFECTIVE_LOG:-$DATA_HOME/state/cockpit-server.log}"
PORT="$COCKPIT_EFFECTIVE_PORT"
ENV_ARG=("${COCKPIT_NODE_ENV_ARGS[@]}")

listening() { ss -tln 2>/dev/null | grep -q ":$1 "; }
busy() { listening "$PORT"; }

# Все PID'ы, слушающие порт приложения.
pids=$(ss -tlnp 2>/dev/null | grep -E ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
if [ -n "$pids" ]; then
  echo "гашу: $pids"
  # SIGTERM запускает в сервере слив ходов; ждём выхода процессов дольше его бюджета
  # (COCKPIT_SHUTDOWN_TIMEOUT_MS, 30 с): порт освобождается раньше, чем отработают хуки
  # остановки, и новый сервер иначе упёрся бы в блокировку папки данных.
  cockpit_stop_pids 45 $pids
fi
if busy; then
  listening "$PORT" && echo "порт :$PORT всё ещё занят — не стартую" >&2
  exit 1
fi

( umask 077; mkdir -p "$(dirname "$LOG")" )
cd "$ROOT"
setsid nohup node "${ENV_ARG[@]}" server/src/app.ts </dev/null >>"$LOG" 2>&1 &
disown

# Живость проверяем по /api/auth/state: он публичный (нужен экрану входа), а /api/health
# закрыт гардом авторизации — по нему скрипт всегда решал бы, что сервер не поднялся.
for _ in $(seq 1 50); do
  if curl -sf "http://localhost:$PORT/api/auth/state" >/dev/null 2>&1; then
    echo "кокпит поднят на :$PORT · лог: $LOG"
    exit 0
  fi
  sleep 0.2
done
echo "сервер не поднялся за 10с — смотри $LOG" >&2
exit 1
