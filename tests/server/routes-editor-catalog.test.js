import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import routesModule from '../../server/src/modules/routes/index.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeDraft } from '../fixtures/routes-editor.mjs';
import { createRoute, cloneRoute, renameRoute, removeRoute } from '../../web/src/views/routes/catalogCommands.ts';
import { addNode, setEscalation, setTransition } from '../../web/src/views/routes/routeCommands.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const BASE = '/api/routes/sample/drafts';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-editor-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'sample');
  await fs.mkdir(path.join(profileDir, 'routes'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'graph.json'), '{}');
  await fs.writeFile(path.join(profileDir, 'routes', 'editor-capabilities.json'),
    JSON.stringify({ schema: 1, commands: [], contextSections: [] }));
  const routesDir = path.join(root, 'routes');
  const app = Fastify({ logger: false });
  await app.register(routesModule, { config: {
    routesDir, routesAuthoringDir: path.join(root, 'authoring'), profilesDir,
  }, prefs: { read: () => ({ projects: { sample: {} } }),
    write: () => { throw new Error('Тест не записывает prefs'); } } });
  await app.ready();
  t.after(() => app.close());
  const source = await app.inject({ method: 'PUT', url: '/api/routes/sample/editor/source',
    payload: { mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: null } });
  assert.equal(source.statusCode, 200);
  return { app, store: new RoutesStore({ baseDir: routesDir }) };
}

function scratchCatalog() {
  let draft = makeDraft();
  draft.routes = {};
  draft = createRoute(draft, 'quick', 'Быстрый').draft;
  draft = addNode(draft, { kind: 'route', routeId: 'quick' }, 'agent', () => 'BUILD').draft;
  draft.routes.quick.prompts['prompts/build.base.md'] = 'Создай результат.\n';
  for (const [outcome, stop] of [
    ['done', 'done'], ['skipped', 'human'], ['failed', 'failed'], ['exhausted', 'human'],
  ]) {
    draft = setTransition(draft, { kind: 'route', routeId: 'quick' }, 'build',
      outcome, { stop }).draft;
  }
  draft = cloneRoute(draft, 'quick', 'audit').draft;
  draft.routes.audit.prompts['prompts/build.base.md'] = 'Перечисли риски.\n';
  draft = setEscalation(draft, { kind: 'bootstrap' }, 'scout', ['quick', 'audit'], true).draft;
  draft = setTransition(draft, { kind: 'bootstrap' }, 'scout', 'done',
    { escalate: { routes: ['quick', 'audit'] } }).draft;
  return draft;
}

async function createDocument(app, draft) {
  const response = await app.inject({ method: 'POST', url: BASE, payload: {
    kind: 'document', title: draft.title, baseCatalogHash: null,
    baseSourceRevision: 1, document: {
      routes: draft.routes, bootstrap: draft.bootstrap,
      bootstrapPrompts: draft.bootstrapPrompts,
      presentation: draft.presentation, provenance: draft.provenance,
    },
  } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

test('RE-F7-01: созданные с нуля маршруты и bootstrap публикуются одним catalog hash',
  async (t) => {
    const { app, store } = await fixture(t);
    const draft = await createDocument(app, scratchCatalog());
    const validated = await app.inject({ method: 'POST',
      url: `${BASE}/${draft.id}/validate`, payload: { expectedRevision: 1 } });
    assert.equal(validated.statusCode, 200, validated.body);
    assert.equal(validated.json().issues.filter((issue) => issue.severity === 'error').length,
      0, validated.body);
    const published = await app.inject({ method: 'POST',
      url: `${BASE}/${draft.id}/publish`, payload: {
        expectedRevision: 1, expectedCatalogHash: null, expectedSourceRevision: 1,
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      } });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json().state, 'committed');
    const current = await store.readCurrent('sample');
    assert.equal(current.catalogHash, published.json().toCatalogHash);
    assert.deepEqual(Object.keys(current.catalog.routes).sort(), ['audit', 'quick']);
    assert.deepEqual(current.bootstrap.nodes[0].on.done.escalate.routes, ['quick', 'audit']);
    assert.equal(current.prompts['bootstrap/prompts/scout.base.md'],
      'Выбери маршрут из каталога.\n');
    const audit = await store.readRoute('sample', 'audit', current.catalog.routes.audit);
    assert.equal(audit.prompts['prompts/build.base.md'], 'Перечисли риски.\n');
  });

test('RE-F7-02: rename публикует новый hash, прежний bundle остаётся byte-for-byte',
  async (t) => {
    const { app, store } = await fixture(t);
    const firstDraft = await createDocument(app, scratchCatalog());
    const firstPublish = await app.inject({ method: 'POST',
      url: `${BASE}/${firstDraft.id}/publish`, payload: {
        expectedRevision: 1, expectedCatalogHash: null, expectedSourceRevision: 1,
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      } });
    assert.equal(firstPublish.statusCode, 200, firstPublish.body);
    const oldHash = firstPublish.json().toCatalogHash;
    const oldBundle = await store.readCatalog('sample', oldHash);
    const oldBytes = JSON.stringify(oldBundle);
    const clone = await app.inject({ method: 'POST', url: BASE, payload: {
      kind: 'catalog', title: 'Переименование', catalogHash: oldHash,
    } });
    assert.equal(clone.statusCode, 201, clone.body);
    const draft = clone.json();
    const renamed = renameRoute(draft, 'quick', 'quick_fix').draft;
    const patch = await app.inject({ method: 'PATCH', url: `${BASE}/${draft.id}`, payload: {
      expectedRevision: 1,
      operations: [
        { kind: 'removeRoute', routeId: 'quick' },
        { kind: 'putRoute', routeId: 'quick_fix', ...renamed.routes.quick_fix },
        { kind: 'putBootstrap', bootstrap: renamed.bootstrap,
          prompts: renamed.bootstrapPrompts },
      ],
    } });
    assert.equal(patch.statusCode, 200, patch.body);
    const second = await app.inject({ method: 'POST',
      url: `${BASE}/${draft.id}/publish`, payload: {
        expectedRevision: 2, expectedCatalogHash: oldHash, expectedSourceRevision: 1,
        operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      } });
    assert.equal(second.statusCode, 200, second.body);
    assert.notEqual(second.json().toCatalogHash, oldHash);
    assert.equal(JSON.stringify(await store.readCatalog('sample', oldHash)), oldBytes);
    const current = await store.readCurrent('sample');
    assert.deepEqual(Object.keys(current.catalog.routes).sort(), ['audit', 'quick_fix']);
    assert.deepEqual(current.bootstrap.escalation[0].allowedRoutes, ['quick_fix', 'audit']);
  });

test('RE-F7-03: висячая ссылка и пустой каталог сохраняются, но блокируют publish',
  async (t) => {
    const { app, store } = await fixture(t);
    const draft = await createDocument(app, scratchCatalog());
    const removed = removeRoute(draft, 'audit').draft;
    const deletion = await app.inject({ method: 'PATCH', url: `${BASE}/${draft.id}`, payload: {
      expectedRevision: 1, operations: [{ kind: 'removeRoute', routeId: 'audit' }],
    } });
    assert.equal(deletion.statusCode, 200, deletion.body);
    assert.equal(deletion.json().revision, 2);
    const invalid = await app.inject({ method: 'POST', url: `${BASE}/${draft.id}/validate`,
      payload: { expectedRevision: 2 } });
    assert.equal(invalid.statusCode, 200, invalid.body);
    assert.ok(invalid.json().issues.some((issue) => issue.code === 'route_reference_missing'));
    const blocked = await app.inject({ method: 'POST',
      url: `${BASE}/${draft.id}/publish`, payload: {
        expectedRevision: 2, expectedCatalogHash: null, expectedSourceRevision: 1,
        operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      } });
    assert.equal(blocked.statusCode, 422, blocked.body);
    assert.equal(await store.readCurrent('sample'), null);
    const allowed = setEscalation(removed, { kind: 'bootstrap' }, 'scout', ['quick'], true).draft;
    const fixed = setTransition(allowed, { kind: 'bootstrap' }, 'scout', 'done',
      { escalate: { routes: ['quick'] } }).draft;
    const repair = await app.inject({ method: 'PATCH', url: `${BASE}/${draft.id}`, payload: {
      expectedRevision: 2, operations: [{ kind: 'putBootstrap',
        bootstrap: fixed.bootstrap, prompts: fixed.bootstrapPrompts }],
    } });
    assert.equal(repair.statusCode, 200, repair.body);
    const published = await app.inject({ method: 'POST',
      url: `${BASE}/${draft.id}/publish`, payload: {
        expectedRevision: 3, expectedCatalogHash: null, expectedSourceRevision: 1,
        operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      } });
    assert.equal(published.statusCode, 200, published.body);
    const currentHash = published.json().toCatalogHash;
    const newDraft = await app.inject({ method: 'POST', url: BASE, payload: {
      kind: 'catalog', title: 'Пустой каталог', catalogHash: currentHash,
    } });
    assert.equal(newDraft.statusCode, 201, newDraft.body);
    const emptied = await app.inject({ method: 'PATCH',
      url: `${BASE}/${newDraft.json().id}`, payload: {
        expectedRevision: 1, operations: [{ kind: 'removeRoute', routeId: 'quick' }],
      } });
    assert.equal(emptied.statusCode, 200, emptied.body);
    const emptyPublish = await app.inject({ method: 'POST',
      url: `${BASE}/${newDraft.json().id}/publish`, payload: {
        expectedRevision: 2, expectedCatalogHash: currentHash, expectedSourceRevision: 1,
        operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      } });
    assert.equal(emptyPublish.statusCode, 422, emptyPublish.body);
    assert.equal((await store.readCurrent('sample')).catalogHash, currentHash);
  });
