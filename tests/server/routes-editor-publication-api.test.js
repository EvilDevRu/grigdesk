import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import routesModule from '../../server/src/modules/routes/index.ts';
import { PublicationJournal } from '../../server/src/modules/routes/publicationJournal.ts';
import { prepareDraftCatalog } from '../../server/src/modules/routes/publicationService.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeDraft } from '../fixtures/routes-editor.mjs';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const runChild = promisify(execFile);
const CURRENT_WRITER = fileURLToPath(new URL('./fixtures/routes-current-writer.mjs', import.meta.url));

function fakeScheduler() {
  const callbacks = new Map();
  let next = 1;
  return {
    callbacks,
    setInterval(callback, interval) {
      assert.equal(interval, 2000);
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    clearInterval(id) { callbacks.delete(id); },
    async advance() {
      assert.equal(callbacks.size, 1, 'наблюдатель должен иметь один общий timer');
      await Promise.all([...callbacks.values()].map((callback) => callback()));
    },
  };
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-routes-publication-api-'));
  const routesDir = path.join(root, 'routes');
  const authoringDir = path.join(root, 'authoring');
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'sample');
  await fs.mkdir(path.join(profileDir, 'routes'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'graph.json'), '{}');
  await fs.writeFile(path.join(profileDir, 'routes', 'editor-capabilities.json'),
    JSON.stringify({ schema: 1, commands: [{
      id: 'project-check', label: 'Проверка', filesystem: ['state-only'],
    }], contextSections: [] }));
  const store = new RoutesStore({ baseDir: routesDir });
  const events = [];
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast: (name, payload) => events.push({ name, payload }) });
  await app.register(routesModule, {
    config: { routesDir, routesAuthoringDir: authoringDir, profilesDir },
    prefs: {
      read: () => ({ projects: { sample: {} } }),
      write: () => { throw new Error('Публикация не меняет prefs'); },
    },
    ...options,
  });
  await app.ready();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, routesDir, authoringDir, profilesDir, store, app, events, close };
}

async function prepareVersion(store, label) {
  const draft = makeDraft();
  draft.routes.quick.route.title = `Маршрут ${label}`;
  draft.routes.quick.prompts['prompts/build.base.md'] = `Инструкция ${label}.\n`;
  draft.bootstrapPrompts['bootstrap/prompts/scout.base.md'] = `Bootstrap ${label}.\n`;
  return (await prepareDraftCatalog(store, draft)).catalogHash;
}

test('RE-D6-01: rollback exact hash возвращает состав, промпты и bootstrap без смены source',
  async (t) => {
    const { store, app } = await fixture(t);
    const first = await prepareVersion(store, 'A');
    const second = await prepareVersion(store, 'B');
    await store.compareAndSwapCurrent('sample', first, { expectedCatalogHash: null });
    await store.compareAndSwapCurrent('sample', second, { expectedCatalogHash: first });
    await store.switchEditorSource('sample', {
      mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: second,
    });
    const working = await app.inject({
      method: 'POST', url: '/api/routes/sample/drafts',
      payload: { kind: 'catalog', title: 'Незавершённая правка', catalogHash: second },
    });
    assert.equal(working.statusCode, 201, working.body);
    const workingBeforeRollback = working.json();
    const rollback = await app.inject({
      method: 'PUT', url: '/api/routes/sample/current',
      payload: { desiredCatalogHash: first, expectedCatalogHash: second },
    });
    assert.equal(rollback.statusCode, 200);
    assert.deepEqual(rollback.json(), { changed: true, catalogHash: first });
    const current = await store.readCurrent('sample');
    assert.equal(current.catalogHash, first);
    assert.equal(current.catalog.routes.quick.length, 64);
    assert.equal(current.prompts['bootstrap/prompts/scout.base.md'], 'Bootstrap A.\n');
    const route = await store.readRoute('sample', 'quick', current.catalog.routes.quick);
    assert.equal(route.prompts['prompts/build.base.md'], 'Инструкция A.\n');
    assert.deepEqual(await store.readEditorSource('sample'), { mode: 'editor', revision: 1 });
    const workingAfterRollback = await app.inject({
      method: 'GET', url: `/api/routes/sample/drafts/${workingBeforeRollback.id}`,
    });
    assert.equal(workingAfterRollback.statusCode, 200, workingAfterRollback.body);
    assert.deepEqual(workingAfterRollback.json(), workingBeforeRollback);
  });

test('RE-D6-02: stale rollback и повреждённый desired bundle не активируются', async (t) => {
  const { routesDir, store, app } = await fixture(t);
  const first = await prepareVersion(store, 'A');
  const second = await prepareVersion(store, 'B');
  const third = await prepareVersion(store, 'C');
  await store.compareAndSwapCurrent('sample', first, { expectedCatalogHash: null });
  await store.compareAndSwapCurrent('sample', second, { expectedCatalogHash: first });
  const stale = await app.inject({
    method: 'PUT', url: '/api/routes/sample/current',
    payload: { desiredCatalogHash: first, expectedCatalogHash: first },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal((await store.readCurrent('sample')).catalogHash, second);

  await fs.writeFile(path.join(routesDir, 'sample', 'catalog', 'revisions', third,
    'bootstrap', 'scout.json'), '{"tampered":true}\n');
  const corrupted = await app.inject({
    method: 'PUT', url: '/api/routes/sample/current',
    payload: { desiredCatalogHash: third, expectedCatalogHash: second },
  });
  assert.equal(corrupted.statusCode, 422);
  assert.equal((await store.readCurrent('sample')).catalogHash, second);

  const journal = new PublicationJournal(store);
  await store.withProfileMutation('sample', (mutation) => journal.writeIntent(mutation, {
    schema: 1,
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    requestHash: 'a'.repeat(64),
    draftId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    draftRevision: 1,
    fromCatalogHash: first,
    toCatalogHash: third,
    sourceRevision: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  const ambiguous = await app.inject({
    method: 'PUT', url: '/api/routes/sample/current',
    payload: { desiredCatalogHash: first, expectedCatalogHash: second },
  });
  assert.equal(ambiguous.statusCode, 409);
  assert.equal((await store.readCurrent('sample')).catalogHash, second);
});

test('RE-D6-03: save/publish рассылают только точные события без prompt-текста', async (t) => {
  const scheduler = fakeScheduler();
  const { store, app, events, profilesDir } = await fixture(t, { catalogScheduler: scheduler });
  await store.switchEditorSource('sample', {
    mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: null,
  });
  assert.equal((await app.inject({ method: 'GET', url: '/api/routes/sample/editor' })).statusCode,
    200);
  const initial = makeDraft();
  const created = await app.inject({
    method: 'POST', url: '/api/routes/sample/drafts',
    payload: {
      kind: 'document', title: 'Черновик событий',
      baseCatalogHash: null, baseSourceRevision: 1,
      document: {
        routes: initial.routes, bootstrap: initial.bootstrap,
        bootstrapPrompts: initial.bootstrapPrompts,
        presentation: initial.presentation, provenance: initial.provenance,
      },
    },
  });
  assert.equal(created.statusCode, 201);
  const draftId = created.json().id;
  events.length = 0;

  const saved = await app.inject({
    method: 'PATCH', url: `/api/routes/sample/drafts/${draftId}`,
    payload: {
      expectedRevision: 1,
      operations: [{ kind: 'setTitle', title: 'Сохранённый каталог' }],
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().revision, 2);
  assert.deepEqual(events, [{
    name: 'routes-draft-changed',
    payload: { profile: 'sample', draftId, revision: 2, state: 'editing' },
  }]);
  const stale = await app.inject({
    method: 'PATCH', url: `/api/routes/sample/drafts/${draftId}`,
    payload: { expectedRevision: 1, operations: [{ kind: 'setTitle', title: 'Старая правка' }] },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(events.length, 1);

  const body = {
    expectedRevision: 2, expectedCatalogHash: null,
    expectedSourceRevision: 1,
    operationId: '88888888-8888-4888-8888-888888888888',
  };
  const published = await app.inject({
    method: 'POST', url: `/api/routes/sample/drafts/${draftId}/publish`, payload: body,
  });
  assert.equal(published.statusCode, 200);
  assert.equal(published.json().state, 'committed');
  assert.deepEqual(events.slice(1), [
    {
      name: 'routes-draft-changed',
      payload: { profile: 'sample', draftId, revision: 2, state: 'published' },
    },
    {
      name: 'routes-catalog-changed',
      payload: {
        profile: 'sample', catalogHash: published.json().toCatalogHash, sourceRevision: 1,
      },
    },
  ]);
  assert.equal(JSON.stringify(events).includes('Создай проверяемый результат'), false);
  const repeated = await app.inject({
    method: 'POST', url: `/api/routes/sample/drafts/${draftId}/publish`, payload: body,
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(events.length, 3);
  await scheduler.advance();
  assert.equal(events.length, 3);

  const earlier = await prepareVersion(store, 'для отката');
  const rollback = await app.inject({
    method: 'PUT', url: '/api/routes/sample/current',
    payload: {
      desiredCatalogHash: earlier,
      expectedCatalogHash: published.json().toCatalogHash,
    },
  });
  assert.equal(rollback.statusCode, 200);
  assert.deepEqual(events.at(-1), {
    name: 'routes-catalog-changed',
    payload: { profile: 'sample', catalogHash: earlier, sourceRevision: 1 },
  });
  await scheduler.advance();
  assert.equal(events.length, 4);

  await store.switchEditorSource('sample', {
    mode: 'profile-script', expectedSourceRevision: 1, expectedCatalogHash: earlier,
  });
  const scriptHash = await prepareVersion(store, 'скрипта');
  const storeModuleUrl = new URL('../../server/src/modules/routes/store.ts', import.meta.url).href;
  await fs.writeFile(path.join(profilesDir, 'sample', 'routes', 'publish.mjs'), [
    `import { RoutesStore } from ${JSON.stringify(storeModuleUrl)};`,
    `const target = ${JSON.stringify(scriptHash)};`,
    'const index = process.argv.indexOf("--base-dir");',
    'const store = new RoutesStore({ baseDir: process.argv[index + 1] });',
    `await store.compareAndSwapCurrent('sample', target, { expectedCatalogHash: ${JSON.stringify(earlier)} });`,
    'process.stdout.write(JSON.stringify({ catalogHash: target }));',
    '',
  ].join('\n'));
  const scripted = await app.inject({
    method: 'POST', url: '/api/routes/sample/publish',
    payload: { mode: 'publish', expectedCatalogHash: earlier },
  });
  assert.equal(scripted.statusCode, 200);
  assert.deepEqual(events.at(-1), {
    name: 'routes-catalog-changed',
    payload: { profile: 'sample', catalogHash: scriptHash, sourceRevision: 2 },
  });
  await scheduler.advance();
  assert.equal(events.length, 5);
});

test('RE-D6-04: общий observer замечает внешний current ровно один раз за tick', async (t) => {
  const scheduler = fakeScheduler();
  const { routesDir, store, app, events } = await fixture(t, { catalogScheduler: scheduler });
  const desired = await prepareVersion(store, 'внешний');
  const viewed = await app.inject({ method: 'GET', url: '/api/routes/sample/editor' });
  assert.equal(viewed.statusCode, 200);
  events.length = 0;
  const child = await runChild(process.execPath,
    [CURRENT_WRITER, routesDir, desired, 'null'], { timeout: 10000 });
  assert.deepEqual(JSON.parse(child.stdout), { changed: true, catalogHash: desired });
  await scheduler.advance();
  assert.deepEqual(events, [{
    name: 'routes-catalog-changed',
    payload: { profile: 'sample', catalogHash: desired, sourceRevision: 0 },
  }]);
  await scheduler.advance();
  assert.equal(events.length, 1);
});

test('RE-D6-05: status восстанавливает intent, onClose снимает timer, новый сервер читает receipt',
  async (t) => {
    const scheduler = fakeScheduler();
    const { routesDir, authoringDir, profilesDir, store, app, close } =
      await fixture(t, { catalogScheduler: scheduler });
    await store.switchEditorSource('sample', {
      mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: null,
    });
    const initial = makeDraft();
    const created = await app.inject({
      method: 'POST', url: '/api/routes/sample/drafts',
      payload: {
        kind: 'document', title: 'Для проверки восстановления',
        baseCatalogHash: null, baseSourceRevision: 1,
        document: {
          routes: initial.routes, bootstrap: initial.bootstrap,
          bootstrapPrompts: initial.bootstrapPrompts,
          presentation: initial.presentation, provenance: initial.provenance,
        },
      },
    });
    assert.equal(created.statusCode, 201);
    const draft = created.json();
    const toCatalogHash = await prepareVersion(store, 'неактивный');
    const operationId = '99999999-9999-4999-8999-999999999999';
    const input = {
      draftId: draft.id, expectedRevision: 1, expectedCatalogHash: null,
      expectedSourceRevision: 1, operationId,
    };
    const requestHash = createHash('sha256').update(JSON.stringify({
      profile: 'sample', ...input,
    })).digest('hex');
    const journal = new PublicationJournal(store);
    await store.withProfileMutation('sample', (mutation) => journal.writeIntent(mutation, {
      schema: 1, operationId, requestHash,
      draftId: draft.id, draftRevision: 1,
      fromCatalogHash: null, toCatalogHash, sourceRevision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const viewed = await app.inject({ method: 'GET', url: '/api/routes/sample/editor' });
    assert.equal(viewed.statusCode, 200);
    assert.equal(scheduler.callbacks.size, 1);

    const status = await app.inject({
      method: 'GET', url: `/api/routes/sample/publications/${operationId}`,
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().state, 'aborted');
    assert.deepEqual(await journal.readReceipt('sample', operationId), status.json());
    assert.equal(await journal.readIntent('sample'), null);
    await close();
    assert.equal(scheduler.callbacks.size, 0);

    const another = Fastify({ logger: false });
    await another.register(routesModule, {
      config: { routesDir, routesAuthoringDir: authoringDir, profilesDir },
      prefs: { read: () => ({ projects: { sample: {} } }), write: () => {} },
    });
    await another.ready();
    t.after(() => another.close());
    const historical = await another.inject({
      method: 'GET', url: `/api/routes/sample/publications/${operationId}`,
    });
    assert.equal(historical.statusCode, 200);
    assert.deepEqual(historical.json(), status.json());
    const history = await another.inject({
      method: 'GET', url: '/api/routes/sample/revisions',
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().revisions.some((item) => item.catalogHash === toCatalogHash), true);
  });
