#!/usr/bin/env bash
# Минимальный настоящий begin использует только synthetic bundle и свои roots.
# Родитель проверяет pin/active ordering; никакого provider или модели здесь нет.
set -uo pipefail
source "$FACTORY_HOME/lib/attempt-state.sh"
routes_dir="$TEST_ROOT/routes"
"$NODE_BIN" "$FACTORY_TESTS_HOME/fixtures/routes-publish.mjs" \
  "$routes_dir" 'Синтетический маршрут runtime pin' null >/dev/null || exit $?
attempt=$(attempt_state_begin_v2 42 demo-profile "$routes_dir")
rc=$?
(( rc == 0 )) || exit "$rc"
printf '%s\n' "$attempt"
# Это маркер допуска к следующей фазе, а не вызов провайдера.
# Ошибка bind обязана остановить shell раньше этой строки.
printf 'допущено\n' >"$TEST_ROOT/provider.marker"
