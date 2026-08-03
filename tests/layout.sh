#!/usr/bin/env bash
# Архитектурная граница: docs и tests принадлежат репозиторию, а не runtime-подсистемам.
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RC=0

for required in \
  docs/cockpit \
  docs/engine \
  tests/docs \
  tests/engine \
  tests/server \
  tests/web; do
  if [[ -d "$PROJECT_ROOT/$required" ]]; then
    printf 'ok - %s\n' "$required"
  else
    printf 'not ok - отсутствует %s\n' "$required"
    RC=1
  fi
done

for forbidden in \
  .claude/knowledge \
  engine/docs \
  engine/profiles \
  engine/tests \
  server/test \
  server/tests \
  web/test \
  web/tests; do
  if [[ ! -e "$PROJECT_ROOT/$forbidden" ]]; then
    printf 'ok - нет устаревшего %s\n' "$forbidden"
  else
    printf 'not ok - тесты или документация снова разбросаны: %s\n' "$forbidden"
    RC=1
  fi
done

if git -C "$PROJECT_ROOT" ls-files profiles | grep -q .; then
  printf 'not ok - локальные профили не должны отслеживаться Git\n'
  RC=1
else
  printf 'ok - локальные профили не отслеживаются Git\n'
fi

if git -C "$PROJECT_ROOT" check-ignore -q profiles/.layout-contract-probe; then
  printf 'ok - profiles/ защищён корневым .gitignore\n'
else
  printf 'not ok - profiles/ должен целиком игнорироваться\n'
  RC=1
fi

exit "$RC"
