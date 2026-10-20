#!/usr/bin/env bash
# Проверяет, что декларация редактора совпадает с фактическими guards и адаптерами.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/route-runtime.sh"

declared=$("$FACTORY_HOME/bin/factory-route" --profile sample editor-capabilities |
  python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)["nativeFanoutRunners"]))')
actual=""
for runner in claude codex kimi deepseek glm; do
  source "$FACTORY_HOME/lib/runners/$runner.sh"
  capabilities=$("runner_${runner}_capabilities")
  if [[ " $capabilities " == *' fanout '* ]]; then
    actual="${actual:+$actual }$runner"
  fi
done
assert_eq "$actual" "$declared" 'native fanout metadata совпадает с адаптерами'

_route_v2_node_caps_guard agent state-only parallel 2 allow-single none
assert_rc 0 "$?" 'state-only agent допускает parallel с downgrade'
_route_v2_node_caps_guard agent workspace-write parallel 2 forbid none >/dev/null 2>&1
assert_rc 78 "$?" 'workspace-write не исполняется в parallel'
_route_v2_node_caps_guard command state-only parallel 2 forbid none >/dev/null 2>&1
assert_rc 78 "$?" 'command не исполняется в parallel'
_route_v2_node_caps_guard agent state-only single 1 forbid same-runner >/dev/null 2>&1
assert_rc 78 "$?" 'same-runner не доходит до запуска модели'

finish_tests
