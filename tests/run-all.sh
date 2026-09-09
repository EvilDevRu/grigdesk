#!/usr/bin/env bash
# Единый офлайн-прогон проекта: не запускает Cockpit и не вызывает реальные ИИ.
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RC=0

bash "$PROJECT_ROOT/tests/layout.sh" || RC=1
# Часть проверок уже на TypeScript: снятие типов задаётся явно, чтобы прогон
# не зависел от версии Node, где оно включено по умолчанию.
node --experimental-strip-types --disable-warning=ExperimentalWarning --test \
  "$PROJECT_ROOT"/tests/docs/*.test.mjs "$PROJECT_ROOT"/tests/docs/*.test.mts || RC=1
bash "$PROJECT_ROOT/tests/engine/run-offline.sh" || RC=1
npm --prefix "$PROJECT_ROOT/server" test || RC=1
npm --prefix "$PROJECT_ROOT/web" test || RC=1

exit "$RC"
