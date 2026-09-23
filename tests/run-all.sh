#!/usr/bin/env bash
# Единый офлайн-прогон проекта: не запускает Cockpit и не вызывает реальные ИИ.
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RC=0

# Один прогон на рабочее дерево. Параллельные копии кодируют одно и то же видео в
# showcase-тестах, вешают машину и перетирают логи друг друга, а человеку со стороны
# лишний прогон неотличим от брошенного. Лок снимает ядро при закрытии дескриптора,
# так что kill и падение не оставляют мусора; дескриптор наследуют дети, поэтому лок
# держится, пока жив хоть один процесс прогона — его и называем в отказе, ведь
# записанный в файле pid к этому моменту мог уже смениться на потомка.
RUN_ALL_LOCK="$PROJECT_ROOT/.state/run-all.lock"
mkdir -p "$(dirname "$RUN_ALL_LOCK")"

if command -v flock >/dev/null 2>&1; then
  exec {RUN_ALL_LOCK_FD}<>"$RUN_ALL_LOCK"

  if ! flock -n "$RUN_ALL_LOCK_FD"; then
    echo "В этом дереве прогон уже идёт: $(cat "$RUN_ALL_LOCK" 2>/dev/null)" >&2

    if command -v fuser >/dev/null 2>&1; then
      echo "Держат процессы: $(fuser "$RUN_ALL_LOCK" 2>/dev/null | tr -s ' ')" >&2
    fi

    echo "Второй прогон здесь не нужен — дождись первого или останови его сам." >&2
    exit 3
  fi

  printf 'pid=%s дерево=%s начат=%s\n' "$$" "$PROJECT_ROOT" "$(date '+%Y-%m-%d %H:%M:%S')" \
    >"$RUN_ALL_LOCK"
else
  echo "Внимание: flock недоступен, защита от параллельного прогона выключена." >&2
fi

bash "$PROJECT_ROOT/tests/layout.sh" || RC=1
# Часть проверок уже на TypeScript: с минимумом Node 22.18 они исполняются как есть.
node --test "$PROJECT_ROOT"/tests/docs/*.test.mjs "$PROJECT_ROOT"/tests/docs/*.test.mts || RC=1
bash "$PROJECT_ROOT/tests/engine/run-offline.sh" || RC=1
npm --prefix "$PROJECT_ROOT/server" test || RC=1
npm --prefix "$PROJECT_ROOT/web" test || RC=1

exit "$RC"
