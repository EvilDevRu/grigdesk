import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DraftStore } from '../../server/src/modules/routes/draftStore.ts';
import { RoutesPublicationCoordinator } from '../../server/src/modules/routes/publicationCoordinator.ts';
import { prepareDraftCatalog } from '../../server/src/modules/routes/publicationService.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeDraft } from '../fixtures/routes-editor.mjs';
import routesModule from '../../server/src/modules/routes/index.ts';

const OPERATION_A = '44444444-4444-4444-8444-444444444444';
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-publication-journal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'sample');
  await fs.mkdir(path.join(profileDir, 'routes'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'graph.json'), '{}');
  await fs.writeFile(path.join(profileDir, 'routes', 'editor-capabilities.json'),
    JSON.stringify({ schema: 1, commands: [{
      id: 'project-check', label: 'Проверка', filesystem: ['state-only'],
    }], contextSections: [] }));
  const routesDir = path.join(root, 'routes');
  const store = new RoutesStore({ baseDir: routesDir });
  const drafts = new DraftStore({ baseDir: path.join(root, 'authoring'), routesStore: store });
  await store.switchEditorSource('sample', {
    mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: null,
  });
  const coordinator = new RoutesPublicationCoordinator(store, drafts, profilesDir);
  return { root, routesDir, store, drafts, coordinator, profilesDir };
}

async function createDraft(drafts, baseCatalogHash = null) {
  const value = makeDraft();
  return drafts.create('sample', {
    title: 'Синтетический каталог', baseCatalogHash, baseSourceRevision: 1,
    document: {
      routes: value.routes, bootstrap: value.bootstrap,
      bootstrapPrompts: value.bootstrapPrompts,
      presentation: value.presentation, provenance: value.provenance,
    },
  });
}

function request(draft, operationId, expectedCatalogHash = null) {
  return {
    draftId: draft.id,
    expectedRevision: draft.revision,
    expectedCatalogHash,
    expectedSourceRevision: 1,
    operationId,
  };
}

test('RE-D4-01: повтор operationId отдаёт durable receipt без второй активации', async (t) => {
  const { root, store, drafts, coordinator } = await fixture(t);
  const draft = await createDraft(drafts);
  const input = request(draft, OPERATION_A);
  const first = await coordinator.publish('sample', input);
  const pointer = path.join(root, 'routes', 'sample', 'catalog', 'current.json');
  const before = await fs.stat(pointer);
  const repeated = await coordinator.publish('sample', input);
  assert.deepEqual(repeated, first);
  assert.equal((await fs.stat(pointer)).ino, before.ino);
  assert.equal((await store.readCurrent('sample')).catalogHash, first.toCatalogHash);
  const receiptFile = path.join(root, 'routes', 'sample', 'catalog',
    'editor-operations', `${OPERATION_A}.json`);
  assert.deepEqual(JSON.parse(await fs.readFile(receiptFile, 'utf8')), first);
});

test('RE-D4-02: повтор ID с другой revision/hash отвергается без записи', async (t) => {
  const { store, drafts, coordinator } = await fixture(t);
  const draft = await createDraft(drafts);
  const input = request(draft, OPERATION_A);
  const first = await coordinator.publish('sample', input);
  for (const changed of [
    { ...input, expectedRevision: 2 },
    { ...input, expectedCatalogHash: first.toCatalogHash },
  ]) {
    await assert.rejects(coordinator.publish('sample', changed), {
      code: 'routes_operation_reused',
    });
  }
  assert.equal((await store.readCurrent('sample')).catalogHash, first.toCatalogHash);
  assert.deepEqual(await coordinator.journal.readReceipt('sample', OPERATION_A), first);
});

test('RE-D4-03: исторический повтор A после публикации B не возвращает current к A',
  async (t) => {
    const { store, drafts, coordinator } = await fixture(t);
    const draftA = await createDraft(drafts);
    const inputA = request(draftA, OPERATION_A);
    const receiptA = await coordinator.publish('sample', inputA);

    const draftB = await createDraft(drafts, receiptA.toCatalogHash);
    const changed = structuredClone(draftB.routes.quick);
    changed.prompts['prompts/build.base.md'] = 'Инструкция B.\n';
    const edited = await drafts.patch('sample', draftB.id, {
      expectedRevision: 1,
      operations: [{ kind: 'putRoute', routeId: 'quick', ...changed }],
    });
    const receiptB = await coordinator.publish('sample', request(
      edited, '55555555-5555-4555-8555-555555555555', receiptA.toCatalogHash,
    ));
    assert.notEqual(receiptB.toCatalogHash, receiptA.toCatalogHash);

    const repeatedA = await coordinator.publish('sample', inputA);
    assert.deepEqual(repeatedA, receiptA);
    assert.equal((await store.readCurrent('sample')).catalogHash, receiptB.toCatalogHash);
  });

test('RE-D4-04: исторический повтор A после rollback не отменяет откат', async (t) => {
  const { store, drafts, coordinator } = await fixture(t);
  const baseline = makeDraft();
  baseline.routes.quick.route.title = 'Версия до публикации A';
  const prepared = await prepareDraftCatalog(store, baseline);
  await store.compareAndSwapCurrent('sample', prepared.catalogHash, {
    expectedCatalogHash: null,
  });
  const draft = await createDraft(drafts, prepared.catalogHash);
  const input = request(draft, OPERATION_A, prepared.catalogHash);
  const receiptA = await coordinator.publish('sample', input);
  assert.notEqual(receiptA.toCatalogHash, prepared.catalogHash);
  await store.compareAndSwapCurrent('sample', prepared.catalogHash, {
    expectedCatalogHash: receiptA.toCatalogHash,
  });
  assert.deepEqual(await coordinator.publish('sample', input), receiptA);
  assert.equal((await store.readCurrent('sample')).catalogHash, prepared.catalogHash);
});

test('RE-D4-05: новый coordinator читает receipt с диска', async (t) => {
  const { root, store, drafts, coordinator, profilesDir } = await fixture(t);
  const draft = await createDraft(drafts);
  const input = request(draft, OPERATION_A);
  const receipt = await coordinator.publish('sample', input);
  const anotherStore = new RoutesStore({ baseDir: path.join(root, 'routes') });
  const anotherDrafts = new DraftStore({
    baseDir: path.join(root, 'authoring'), routesStore: anotherStore,
  });
  const another = new RoutesPublicationCoordinator(anotherStore, anotherDrafts, profilesDir);
  assert.deepEqual(await another.publish('sample', input), receipt);
  assert.equal((await anotherStore.readCurrent('sample')).catalogHash, receipt.toCatalogHash);

  const app = Fastify({ logger: false });
  await app.register(routesModule, {
    config: {
      routesDir: path.join(root, 'routes'),
      routesAuthoringDir: path.join(root, 'authoring'), profilesDir,
    },
    prefs: {
      read: () => ({ projects: { sample: {} } }),
      write: () => { throw new Error('receipt не пишет prefs'); },
    },
  });
  await app.ready();
  t.after(() => app.close());
  const status = await app.inject({
    method: 'GET', url: `/api/routes/sample/publications/${OPERATION_A}`,
  });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json(), receipt);
});

test('RE-D4-06: aborted receipt не возобновляет старый operationId', async (t) => {
  const { store, drafts, coordinator } = await fixture(t);
  const draft = await createDraft(drafts);
  const input = request(draft, OPERATION_A);
  await assert.rejects(coordinator.publish('sample', input, {
    afterIntent: async () => { throw new Error('синтетический отказ до CAS'); },
  }), /синтетический отказ/);
  const aborted = await coordinator.publish('sample', input);
  assert.equal(aborted.state, 'aborted');
  assert.equal(aborted.currentChanged, false);
  assert.equal(await store.readCurrent('sample'), null);
  assert.equal((await drafts.read('sample', draft.id)).state, 'editing');
  const retried = await coordinator.publish('sample', {
    ...input, operationId: '66666666-6666-4666-8666-666666666666',
  });
  assert.equal(retried.state, 'committed');
  assert.equal((await store.readCurrent('sample')).catalogHash, retried.toCatalogHash);
});

test('RE-D4-07: два проверившихся запроса с одним ID получают один receipt', async (t) => {
  const { store, drafts, coordinator } = await fixture(t);
  const draft = await createDraft(drafts);
  const input = request(draft, OPERATION_A);
  let count = 0;
  let release;
  let bothEntered;
  const ready = new Promise((resolve) => { bothEntered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const hook = async () => {
    count += 1;
    if (count === 2) bothEntered();
    await barrier;
  };
  const first = coordinator.publish('sample', input, { beforeActivation: hook });
  const second = coordinator.publish('sample', input, { beforeActivation: hook });
  await ready;
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(a.state, 'committed');
  assert.equal((await store.readCurrent('sample')).catalogHash, a.toCatalogHash);
  assert.equal((await drafts.read('sample', draft.id)).state, 'published');
});

test('RE-G1-05: комментарий переживает receipt/recovery и не меняет исполняемый hash',
  async (t) => {
    const { store, drafts, coordinator } = await fixture(t);
    const draft = await createDraft(drafts);
    const input = { ...request(draft, OPERATION_A), comment: 'Проверена новая инструкция.' };
    await assert.rejects(coordinator.publish('sample', input, {
      afterActivation: async () => { throw new Error('синтетический обрыв после CAS'); },
    }), /синтетический обрыв/);
    const restored = await coordinator.status('sample', OPERATION_A);
    assert.equal(restored.state, 'committed');
    assert.equal(restored.comment, input.comment);
    assert.deepEqual(await coordinator.publish('sample', input), restored);
    await assert.rejects(coordinator.publish('sample', {
      ...input, comment: 'Другой текст',
    }), { code: 'routes_operation_reused' });
    const sameContent = await createDraft(drafts, restored.toCatalogHash);
    const olderStyle = await coordinator.publish('sample', request(sameContent,
      '77777777-7777-4777-8777-777777777777', restored.toCatalogHash));
    assert.equal(olderStyle.toCatalogHash, restored.toCatalogHash);
    assert.equal(Object.hasOwn(olderStyle, 'comment'), false);
    assert.equal((await store.readCatalog('sample', restored.toCatalogHash)).catalogHash,
      restored.toCatalogHash);
  });
