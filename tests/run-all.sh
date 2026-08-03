#!/usr/bin/env bash
# Единый офлайн-прогон проекта: не запускает Cockpit и не вызывает реальные ИИ.
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RC=0

bash "$PROJECT_ROOT/tests/layout.sh" || RC=1
node --test "$PROJECT_ROOT"/tests/docs/*.test.mjs || RC=1
bash "$PROJECT_ROOT/tests/engine/run-offline.sh" || RC=1
npm --prefix "$PROJECT_ROOT/server" test || RC=1
npm --prefix "$PROJECT_ROOT/web" test || RC=1

exit "$RC"
