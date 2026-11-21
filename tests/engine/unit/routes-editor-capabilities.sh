#!/usr/bin/env bash
# Проверяет, что декларация редактора совпадает с фактическими guards и адаптерами.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

capabilities=$(fixture_route --profile sample editor-capabilities)
assert_rc 0 "$?" 'редактор возвращает описание возможностей'
declared=$(jq -r '.nativeFanoutRunners | join(" ")' <<<"$capabilities")
assert_eq claude "$declared" 'native fanout metadata совпадает с адаптерами'

fixture_file="$FACTORY_TESTS_HOME/../fixtures/routes-editor.mjs"
"$NODE_BIN" --input-type=module -e '
import { pathToFileURL } from "node:url";
const { makeCatalogInput } = await import(pathToFileURL(process.argv[1]));
process.stdout.write(JSON.stringify(makeCatalogInput()));
' "$fixture_file" >"$TEST_ROOT/editor-capabilities.json" || exit $?

# Одинаковые параметры guard проверяем публичной командой на полном черновике.
# Для отказа сверяем адрес изменённого поля, а не только код выхода.
check_caps() {
  local node=$1 policy=$2 fanout=$3 limit=$4 degrade=$5 strategy=$6 expected=$7 field=$8
  local payload="$TEST_ROOT/editor-caps-case.json" result
  jq --argjson node "$node" --arg policy "$policy" --arg fanout "$fanout" \
    --argjson limit "$limit" --arg degrade "$degrade" --arg strategy "$strategy" '
      .routes.quick.route.nodes[$node] |= (
        .policy.filesystem = $policy |
        .fanout = {mode:$fanout,maxExecutors:$limit,degrade:$degrade} |
        .retry.providerFailure = {strategy:$strategy, attempts:(if $strategy == "none" then 0 else 1 end)}
      )
    ' "$TEST_ROOT/editor-capabilities.json" >"$payload" || exit $?
  result=$(fixture_route --profile sample editor-check <"$payload")
  assert_rc "$expected" "$?" "editor-check: узел $node, права $policy, fanout $fanout, retry $strategy"
  if [[ "$expected" == 78 ]]; then
    assert_contains "$result" "/routes/quick/route/nodes/$node/$field" 'адрес ошибки у изменённого узла'
  else
    assert_contains "$result" '"ok": true' 'разрешённый профиль выполнения принят'
  fi
}

check_caps 0 state-only parallel 2 allow-single none 0 ''
check_caps 0 workspace-write parallel 2 forbid none 78 fanout
check_caps 1 state-only parallel 2 forbid none 78 fanout
check_caps 0 state-only single 1 forbid same-runner 78 retry/providerFailure/strategy

finish_tests
