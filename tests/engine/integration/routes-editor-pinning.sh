#!/usr/bin/env bash
# Две живые попытки читают свои immutable bytes после editor publish и rollback.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
export FACTORY_ROUTE_STATE_DIR="$STATE_DIR"
source "$FACTORY_HOME/lib/route-runtime.sh"

routes_dir="$TEST_ROOT/routes"
authoring_dir="$TEST_ROOT/authoring"
profile_id=sample
publisher="$TEST_ROOT/editor-publish.mjs"
mkdir -p "$FACTORY_PROFILES_DIR/$profile_id/routes"
printf '{}\n' >"$FACTORY_PROFILES_DIR/$profile_id/graph.json"
cat >"$FACTORY_PROFILES_DIR/$profile_id/routes/editor-capabilities.json" <<'JSON'
{"schema":1,"commands":[{"id":"project-check","label":"Проверка","filesystem":["state-only"]}],"contextSections":[]}
JSON
cat >"$publisher" <<'JS'
import { pathToFileURL } from 'node:url';

const [root, routesDir, authoringDir, profilesDir, mode, version, expected] = process.argv.slice(2);
const { RoutesStore } = await import(pathToFileURL(`${root}/server/src/modules/routes/store.ts`));
const { DraftStore } = await import(pathToFileURL(`${root}/server/src/modules/routes/draftStore.ts`));
const { RoutesPublicationCoordinator } = await import(pathToFileURL(
  `${root}/server/src/modules/routes/publicationCoordinator.ts`));
const { makeCatalogInput } = await import(pathToFileURL(`${root}/tests/fixtures/routes-editor.mjs`));
const store = new RoutesStore({ baseDir: routesDir });
const previous = expected === 'null' ? null : expected;
if (mode === 'rollback') {
  const result = await store.compareAndSwapCurrent('sample', version,
    { expectedCatalogHash: previous });
  process.stdout.write(JSON.stringify(result));
} else {
  if (previous === null) {
    await store.switchEditorSource('sample', { mode: 'editor',
      expectedSourceRevision: 0, expectedCatalogHash: null });
  }
  const content = makeCatalogInput();
  content.routes.quick.route.bootstrap = 'skip';
  content.routes.quick.prompts['prompts/build.base.md'] = `ПИН ${version}: точные байты.\n`;
  const drafts = new DraftStore({ baseDir: authoringDir, routesStore: store });
  const draft = await drafts.create('sample', { title: `Каталог ${version}`,
    baseCatalogHash: previous, baseSourceRevision: 1,
    document: { routes: content.routes, bootstrap: content.bootstrap,
      bootstrapPrompts: content.bootstrapPrompts, presentation: {}, provenance: {} } });
  const coordinator = new RoutesPublicationCoordinator(store, drafts, profilesDir);
  const receipt = await coordinator.publish('sample', {
    draftId: draft.id, expectedRevision: 1,
    expectedCatalogHash: previous, expectedSourceRevision: 1,
    operationId: `22222222-2222-4222-8222-${version === 'V1' ? '000000000001' : '000000000002'}`,
  });
  process.stdout.write(JSON.stringify(receipt));
}
JS

publish() {
  "$NODE_BIN" "$publisher" "$FACTORY_HOME/.." "$routes_dir" "$authoring_dir" \
    "$FACTORY_PROFILES_DIR" publish "$1" "$2"
}
rollback() {
  "$NODE_BIN" "$publisher" "$FACTORY_HOME/.." "$routes_dir" "$authoring_dir" \
    "$FACTORY_PROFILES_DIR" rollback "$1" "$2"
}

git init -q "$TEST_ROOT/work"
git -C "$TEST_ROOT/work" config user.email tests@example.invalid
git -C "$TEST_ROOT/work" config user.name Tests
printf 'Синтетический репозиторий\n' >"$TEST_ROOT/work/README.txt"
git -C "$TEST_ROOT/work" add README.txt
git -C "$TEST_ROOT/work" commit -qm baseline

json_hash() {
  "$NODE_BIN" -e 'process.stdout.write(JSON.parse(process.argv[1]).toCatalogHash)' "$1"
}

route_v2_workspace_roots() { printf '%s\n' "$TEST_ROOT/work"; }
route_v2_context_for_node() {
  printf '{"task":{"id":%s,"title":"Синтетическая задача"},"delivery":{"mode":"disabled","actions":[],"targetBranches":{}}}\n' "$1" >"$5"
}
FAKE_EPOCH=0
run_agent() {
  local task=$1 prompt=$2 stage=$3 file
  printf '%s\n' "$prompt" >"$TEST_ROOT/prompt-${task}.txt"
  FAKE_EPOCH=$((FAKE_EPOCH + 1))
  file=$(run_state_active_file "$task" "$stage") || return
  _run_state_write "$file" "fake-${stage}-${FAKE_EPOCH}" "$FAKE_EPOCH" \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    committed done
}

v1=$(publish V1 null)
assert_rc 0 "$?" 'редактор публикует V1'
catalog_v1=$(json_hash "$v1")

ATTEMPT_STATE_ID_OVERRIDE=a_30013001300130013001300130013001
attempt_a=$(attempt_state_begin_v2 3001 "$profile_id" "$routes_dir")
assert_rc 0 "$?" 'попытка A закрепляет current V1'
unset ATTEMPT_STATE_ID_OVERRIDE
attempt_state_select_route_v2 3001 "$attempt_a" quick >/dev/null
assert_rc 0 "$?" 'A закрепляет маршрут quick'
route_v2_dispatch_bootstrap 3001 "$attempt_a" >/dev/null
assert_rc 0 "$?" 'A пропускает разведку по своему route pin'
attempt_stage_state_init_v2 3001 "$attempt_a" quick >/dev/null
assert_rc 0 "$?" 'A готова к resume'

v2=$(publish V2 "$catalog_v1")
assert_rc 0 "$?" 'редактор публикует V2 поверх V1'
catalog_v2=$(json_hash "$v2")
if [[ "$catalog_v1" != "$catalog_v2" ]]; then
  test_ok 'разные prompt bytes дают разные catalog hashes'
else
  test_fail 'разные prompt bytes дают разные catalog hashes'
fi
route_v2_dispatch_next 3001 "$attempt_a" >/dev/null
assert_rc 0 "$?" 'resume A исполняет закреплённый узел'
assert_contains "$(cat "$TEST_ROOT/prompt-3001.txt")" 'ПИН V1: точные байты.' \
  'A после V2 читает prompt V1'

ATTEMPT_STATE_ID_OVERRIDE=a_30023002300230023002300230023002
attempt_b=$(attempt_state_begin_v2 3002 "$profile_id" "$routes_dir")
assert_rc 0 "$?" 'новая попытка B закрепляет V2'
unset ATTEMPT_STATE_ID_OVERRIDE
attempt_state_select_route_v2 3002 "$attempt_b" quick >/dev/null
route_v2_dispatch_bootstrap 3002 "$attempt_b" >/dev/null
attempt_stage_state_init_v2 3002 "$attempt_b" quick >/dev/null

rollback "$catalog_v1" "$catalog_v2" >/dev/null
assert_rc 0 "$?" 'rollback переводит current на V1'
route_v2_dispatch_next 3002 "$attempt_b" >/dev/null
assert_rc 0 "$?" 'B исполняется после rollback'
assert_contains "$(cat "$TEST_ROOT/prompt-3002.txt")" 'ПИН V2: точные байты.' \
  'rollback не меняет pin B'

ATTEMPT_STATE_ID_OVERRIDE=a_30033003300330033003300330033003
attempt_c=$(attempt_state_begin_v2 3003 "$profile_id" "$routes_dir")
assert_rc 0 "$?" 'следующая попытка C закрепляет V1'
unset ATTEMPT_STATE_ID_OVERRIDE
attempt_state_select_route_v2 3003 "$attempt_c" quick >/dev/null
route_v2_dispatch_bootstrap 3003 "$attempt_c" >/dev/null
attempt_stage_state_init_v2 3003 "$attempt_c" quick >/dev/null
route_v2_dispatch_next 3003 "$attempt_c" >/dev/null
assert_rc 0 "$?" 'C исполняется после rollback'
assert_contains "$(cat "$TEST_ROOT/prompt-3003.txt")" 'ПИН V1: точные байты.' \
  'C читает текущую после rollback V1'
finish_tests
