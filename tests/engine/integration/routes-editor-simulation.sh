#!/usr/bin/env bash
# Пробный шаг получает только JSON и не пишет попытку или профильный marker.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

route_tool="$FACTORY_HOME/bin/factory-route"
fixture_file="$FACTORY_TESTS_HOME/../fixtures/routes-editor.mjs"
marker="$TEST_ROOT/forbidden-marker"

make_payload() {
  local step_index=$1 terminal=$2
  "$NODE_BIN" --input-type=module -e '
import { pathToFileURL } from "node:url";
const { makeCatalogInput } = await import(pathToFileURL(process.argv[1]));
const catalogInput = makeCatalogInput();
catalogInput.routes.quick.prompts["prompts/build.base.md"] =
  "$(touch " + process.argv[2] + ")";
process.stdout.write(JSON.stringify({
  catalogInput,
  cursor: { scope: "route", routeId: "quick", nodeId: "build",
    terminal: process.argv[4] === "true" },
  counters: { noResult: {}, productFailure: {}, rewinds: {} },
  outcome: "done", failureOwner: null, selectedRouteId: null,
  pinned: false, stepIndex: Number(process.argv[3]),
}));
' "$fixture_file" "$marker" "$step_index" "$terminal"
}

result=$(make_payload 1 false | "$route_tool" --profile sample editor-step)
assert_rc 0 "$?" 'editor-step вычисляет переход без runtime state'
assert_contains "$result" '"next": "check"' 'результат основан на переходе fixture'

overflow=$(make_payload 201 false | "$route_tool" --profile sample editor-step)
assert_rc 78 "$?" '201-й шаг отвергается до вычисления'
assert_contains "$overflow" 'stepIndex' 'причина лимита сообщается'

terminal=$(make_payload 2 true | "$route_tool" --profile sample editor-step)
assert_rc 78 "$?" 'терминальный сценарий нельзя продолжить'
assert_contains "$terminal" 'терминальный' 'причина остановки сообщается'

assert_file_missing "$marker" 'текст инструкции не был исполнен'
assert_file_missing "$TEST_ROOT/routes" 'не создан runtime bundle'
state_files=$(find "$STATE_DIR" -mindepth 1 -print -quit)
assert_eq '' "$state_files" 'не создана runtime-попытка'
profile_files=$(find "$FACTORY_PROFILES_DIR" -mindepth 1 -print -quit)
assert_eq '' "$profile_files" 'профильные команды не выполнялись'
finish_tests
