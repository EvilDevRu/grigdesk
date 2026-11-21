#!/usr/bin/env bash
# Чистый renderer черновика вызывается через stdin, без current и профильных hook.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

route_tool=fixture_route
fixture_file="$FACTORY_TESTS_HOME/../fixtures/routes-editor.mjs"

make_payload() {
  local scope=$1 context=$2
  "$NODE_BIN" --input-type=module -e '
import { pathToFileURL } from "node:url";
const { makeCatalogInput } = await import(pathToFileURL(process.argv[1]));
const catalogInput = makeCatalogInput();
const scope = process.argv[2];
process.stdout.write(JSON.stringify({
  catalogInput, scope,
  routeId: scope === "route" ? "quick" : null,
  nodeId: scope === "route" ? "build" : "scout",
  context: JSON.parse(process.argv[3]),
}));
' "$fixture_file" "$scope" "$context"
}

make_payload route '{"task":{"kind":"audit"}}' >"$TEST_ROOT/editor-render-route.json" || exit $?
make_payload bootstrap '{"task":{"kind":"audit"},"routeCatalog":{"quick":{}}}' \
  >"$TEST_ROOT/editor-render-bootstrap.json" || exit $?
make_payload route '{}' >"$TEST_ROOT/editor-render-missing.json" || exit $?

route_result=$("$route_tool" --profile sample editor-render <"$TEST_ROOT/editor-render-route.json")
assert_contains "$route_result" 'prompts/build.audit.md' 'условный блок объявлен включённым'
assert_contains "$route_result" 'Для аудита перечисли найденные риски.' 'условный текст рендерится'
assert_contains "$route_result" 'ПОЛИТИКА ФАЙЛОВ ЭТАПА' 'runtime policy включена в текст'

bootstrap_result=$("$route_tool" --profile sample editor-render <"$TEST_ROOT/editor-render-bootstrap.json")
assert_contains "$bootstrap_result" 'Выбери маршрут из каталога.' 'bootstrap рендерится из stdin'

missing=$("$route_tool" --profile sample editor-render <"$TEST_ROOT/editor-render-missing.json")
missing_rc=$?
assert_rc 78 "$missing_rc" 'отсутствующая обязательная секция отклонена'
assert_contains "$missing" 'preview_invalid' 'ошибка обязательной секции адресована'

assert_file_missing "$TEST_ROOT/routes" 'editor-render не создаёт runtime bundle'
finish_tests
