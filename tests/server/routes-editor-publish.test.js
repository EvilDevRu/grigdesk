import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import routesModule from '../../server/src/modules/routes/index.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { DraftStore } from '../../server/src/modules/routes/draftStore.ts';
import { RoutesPublicationCoordinator } from '../../server/src/modules/routes/publicationCoordinator.ts';
import { prepareDraftCatalog } from '../../server/src/modules/routes/publicationService.ts';
import { makeDraft } from '../fixtures/routes-editor.mjs';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const DRAFT_BASE = '/api/routes/sample/drafts';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-editor-publish-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'sample');
  await fs.mkdir(path.join(profileDir, 'routes'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'graph.json'), '{}');
  await fs.writeFile(path.join(profileDir, 'routes', 'editor-capabilities.json'),
    JSON.stringify({
      schema: 1,
      commands: [{ id: 'project-check', label: 'Проверка', filesystem: ['state-only'] }],
      contextSections: [],
    }));
  const routesDir = path.join(root, 'routes');
  const authoringDir = path.join(root, 'authoring');
  const app = Fastify({ logger: false });
  await app.register(routesModule, {
    config: { routesDir, routesAuthoringDir: authoringDir, profilesDir },
    prefs: {
      read: () => ({ projects: { sample: {} } }),
      write: () => { throw new Error('публикация не пишет prefs'); },
    },
  });
  await app.ready();
  t.after(() => app.close());
  const store = new RoutesStore({ baseDir: routesDir });
  const source = await app.inject({
    method: 'PUT', url: '/api/routes/sample/editor/source',
    payload: { mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: null },
  });
  assert.equal(source.statusCode, 200);
  return { root, app, store, profileDir, profilesDir, authoringDir };
}

async function createDraft(app, baseCatalogHash = null) {
  const initial = makeDraft();
  const created = await app.inject({
    method: 'POST', url: DRAFT_BASE,
    payload: {
      kind: 'document', title: 'Публикация',
      baseCatalogHash, baseSourceRevision: 1,
      document: {
        routes: initial.routes,
        bootstrap: initial.bootstrap,
        bootstrapPrompts: initial.bootstrapPrompts,
        presentation: initial.presentation,
        provenance: initial.provenance,
      },
    },
  });
  assert.equal(created.statusCode, 201);
  return created.json();
}

test('RE-D3-01: публикуется сохранённая r2 с точными instructions и закрытием draft',
  async (t) => {
    const { app, store } = await fixture(t);
    const draft = await createDraft(app);
    const bundle = structuredClone(draft.routes.quick);
    bundle.prompts['prompts/build.base.md'] = 'Новая проверяемая инструкция.\n';
    const patched = await app.inject({
      method: 'PATCH', url: `${DRAFT_BASE}/${draft.id}`,
      payload: {
        expectedRevision: 1,
        operations: [{ kind: 'putRoute', routeId: 'quick', ...bundle }],
      },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().revision, 2);

    const published = await app.inject({
      method: 'POST', url: `${DRAFT_BASE}/${draft.id}/publish`,
      payload: {
        expectedRevision: 2,
        expectedCatalogHash: null,
        expectedSourceRevision: 1,
        operationId: OPERATION_ID,
      },
    });
    assert.equal(published.statusCode, 200);
    assert.equal(published.json().state, 'committed');
    assert.equal(published.json().draftRevision, 2);
    const current = await store.readCurrent('sample');
    assert.equal(current.catalogHash, published.json().toCatalogHash);
    const route = await store.readRoute('sample', 'quick', current.catalog.routes.quick);
    assert.equal(route.prompts['prompts/build.base.md'], 'Новая проверяемая инструкция.\n');

    const read = await app.inject({ method: 'GET', url: `${DRAFT_BASE}/${draft.id}` });
    assert.equal(read.json().state, 'published');
    assert.equal(read.json().revision, 2);
    assert.equal(read.json().publication.draftRevision, 2);
    assert.equal(read.json().publication.toCatalogHash, current.catalogHash);
  });

test('RE-D3-02: PATCH после проверки не подменяет публикуемую ревизию', async (t) => {
  const { app, store, profilesDir, authoringDir } = await fixture(t);
  const draft = await createDraft(app);
  const r2 = await app.inject({
    method: 'PATCH', url: `${DRAFT_BASE}/${draft.id}`,
    payload: { expectedRevision: 1, operations: [{ kind: 'setTitle', title: 'Версия r2' }] },
  });
  assert.equal(r2.json().revision, 2);
  const coordinator = new RoutesPublicationCoordinator(store,
    new DraftStore({ baseDir: authoringDir, routesStore: store }), profilesDir);
  let enterBarrier;
  let leaveBarrier;
  const entered = new Promise((resolve) => { enterBarrier = resolve; });
  const released = new Promise((resolve) => { leaveBarrier = resolve; });
  const pending = coordinator.publish('sample', {
    draftId: draft.id,
    expectedRevision: 2,
    expectedCatalogHash: null,
    expectedSourceRevision: 1,
    operationId: OPERATION_ID,
  }, { beforeActivation: async () => { enterBarrier(); await released; } });
  await entered;
  const r3 = await app.inject({
    method: 'PATCH', url: `${DRAFT_BASE}/${draft.id}`,
    payload: { expectedRevision: 2, operations: [{ kind: 'setTitle', title: 'Версия r3' }] },
  });
  assert.equal(r3.json().revision, 3);
  leaveBarrier();
  await assert.rejects(pending, { code: 'routes_draft_conflict' });
  assert.equal(await store.readCurrent('sample'), null);
  const read = await app.inject({ method: 'GET', url: `${DRAFT_BASE}/${draft.id}` });
  assert.equal(read.json().title, 'Версия r3');
  assert.equal(read.json().state, 'editing');
});

test('RE-D3-03: current, source и capabilities меняются на барьере — без автоповтора',
  async (t) => {
    for (const variant of ['current', 'source', 'capabilities']) {
      const { app, store, profilesDir, authoringDir, profileDir } = await fixture(t);
      const draft = await createDraft(app);
      const coordinator = new RoutesPublicationCoordinator(store,
        new DraftStore({ baseDir: authoringDir, routesStore: store }), profilesDir);
      let enterBarrier;
      let leaveBarrier;
      const entered = new Promise((resolve) => { enterBarrier = resolve; });
      const released = new Promise((resolve) => { leaveBarrier = resolve; });
      const pending = coordinator.publish('sample', {
        draftId: draft.id,
        expectedRevision: 1,
        expectedCatalogHash: null,
        expectedSourceRevision: 1,
        operationId: OPERATION_ID,
      }, { beforeActivation: async () => { enterBarrier(); await released; } });
      await entered;
      let expectedCurrent = null;
      if (variant === 'current') {
        const alternate = makeDraft();
        alternate.routes.quick.route.title = 'Внешняя версия';
        const prepared = await prepareDraftCatalog(store, alternate);
        await store.compareAndSwapCurrent('sample', prepared.catalogHash, {
          expectedCatalogHash: null,
        });
        expectedCurrent = prepared.catalogHash;
      } else if (variant === 'source') {
        await store.switchEditorSource('sample', {
          mode: 'profile-script', expectedSourceRevision: 1, expectedCatalogHash: null,
        });
      } else {
        await fs.writeFile(path.join(profileDir, 'routes', 'editor-capabilities.json'),
          JSON.stringify({ schema: 1, commands: [{
            id: 'project-check', label: 'Другая проверка', filesystem: ['state-only'],
          }], contextSections: [] }));
      }
      leaveBarrier();
      await assert.rejects(pending, {
        code: variant === 'current' ? 'routes_catalog_conflict'
          : variant === 'source' ? 'routes_source_conflict' : 'routes_validation_failed',
      }, variant);
      assert.equal((await store.readCurrent('sample'))?.catalogHash ?? null, expectedCurrent);
    }
  });

test('RE-D3-04: неполный draft остаётся редактируемым без active catalog', async (t) => {
  const { app, store } = await fixture(t);
  const draft = await createDraft(app);
  const missing = await app.inject({
    method: 'PATCH', url: `${DRAFT_BASE}/${draft.id}`,
    payload: {
      expectedRevision: 1,
      operations: [{
        kind: 'putRoute', routeId: 'quick',
        route: draft.routes.quick.route, prompts: {},
      }],
    },
  });
  assert.equal(missing.statusCode, 200);
  const publish = await app.inject({
    method: 'POST', url: `${DRAFT_BASE}/${draft.id}/publish`,
    payload: {
      expectedRevision: 2, expectedCatalogHash: null,
      expectedSourceRevision: 1, operationId: OPERATION_ID,
    },
  });
  assert.equal(publish.statusCode, 422);
  assert.equal(publish.json().error, 'routes_validation_failed');
  assert.equal(await store.readCurrent('sample'), null);
  const read = await app.inject({ method: 'GET', url: `${DRAFT_BASE}/${draft.id}` });
  assert.equal(read.json().state, 'editing');
  assert.equal(read.json().revision, 2);
});

test('RE-D3-05: no-op публикация не переписывает current pointer', async (t) => {
  const { app, store, root } = await fixture(t);
  const first = await createDraft(app);
  const publish = (draftId, operationId, expectedCatalogHash) => app.inject({
    method: 'POST', url: `${DRAFT_BASE}/${draftId}/publish`,
    payload: {
      expectedRevision: 1, expectedCatalogHash,
      expectedSourceRevision: 1, operationId,
    },
  });
  const firstResult = await publish(first.id, OPERATION_ID, null);
  assert.equal(firstResult.statusCode, 200);
  const hash = firstResult.json().toCatalogHash;
  const pointer = path.join(root, 'routes', 'sample', 'catalog', 'current.json');
  const before = await fs.stat(pointer);
  const bytesBefore = await fs.readFile(pointer);

  const second = await createDraft(app, hash);
  const repeated = await publish(second.id, '33333333-3333-4333-8333-333333333333', hash);
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().toCatalogHash, hash);
  assert.equal(repeated.json().currentChanged, false);
  assert.equal((await fs.stat(pointer)).ino, before.ino);
  assert.deepEqual(await fs.readFile(pointer), bytesBefore);
  assert.equal((await store.readCurrent('sample')).catalogHash, hash);
});
