import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import routesModule from '../../server/src/modules/routes/index.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeCatalogInput } from '../fixtures/routes-editor.mjs';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const CHILD = fileURLToPath(new URL('./fixtures/routes-source-writer.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-editor-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const routesDir = path.join(root, 'routes');
  const app = Fastify({ logger: false });
  await app.register(routesModule, {
    config: {
      routesDir,
      routesAuthoringDir: path.join(root, 'authoring'),
      profilesDir: path.join(root, 'profiles'),
    },
    prefs: {
      read: () => ({ projects: { sample: {} } }),
      write: () => { throw new Error('источник не меняет prefs'); },
    },
  });
  await app.ready();
  t.after(() => app.close());
  return {
    root,
    app,
    routesDir,
    profilesDir: path.join(root, 'profiles'),
    sourceFile: path.join(routesDir, 'sample', 'catalog', 'editor-source.json'),
    store: new RoutesStore({ baseDir: routesDir }),
  };
}

test('RE-D2-01: отсутствие source означает profile-script/r0 без записи при GET', async (t) => {
  const { app, sourceFile } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/routes/sample/editor' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().source, { mode: 'profile-script', revision: 0 });
  await assert.rejects(fs.stat(sourceFile), { code: 'ENOENT' });
});

async function catalogInput(store, source = makeCatalogInput()) {
  const hashes = {};
  for (const [routeId, bundle] of Object.entries(source.routes)) {
    hashes[routeId] = (await store.publishRoute('sample', routeId, bundle)).routeHash;
  }
  return {
    catalog: {
      schema: 2, profile: 'sample', routes: hashes,
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: source.bootstrap,
    prompts: source.bootstrapPrompts,
  };
}

test('RE-D2-02: source switch сверяет source revision и current hash', async (t) => {
  const { app, sourceFile, store } = await fixture(t);
  const change = (expectedSourceRevision, expectedCatalogHash, mode = 'editor') => app.inject({
    method: 'PUT',
    url: '/api/routes/sample/editor/source',
    payload: { mode, expectedSourceRevision, expectedCatalogHash },
  });
  const switched = await change(0, null);
  assert.equal(switched.statusCode, 200);
  assert.deepEqual(switched.json().source, { mode: 'editor', revision: 1 });
  assert.equal(switched.json().currentCatalogHash, null);
  assert.deepEqual(JSON.parse(await fs.readFile(sourceFile, 'utf8')),
    { schema: 1, mode: 'editor', revision: 1 });
  assert.deepEqual(await store.readEditorSource('sample'), { mode: 'editor', revision: 1 });

  const staleSource = await change(0, null, 'profile-script');
  assert.equal(staleSource.statusCode, 409);
  assert.equal(staleSource.json().error, 'routes_source_conflict');
  const staleCurrent = await change(1, 'a'.repeat(64), 'profile-script');
  assert.equal(staleCurrent.statusCode, 409);
  assert.equal(staleCurrent.json().error, 'routes_catalog_conflict');
  assert.deepEqual(await store.readEditorSource('sample'), { mode: 'editor', revision: 1 });
});

test('RE-D2-03: старый HTTP/child writer не активирует каталог в режиме editor', async (t) => {
  const { root, app, store, routesDir, profilesDir } = await fixture(t);
  const input = await catalogInput(store);
  const initial = await store.publishCatalog('sample', input, { expectedCatalogHash: null });
  const switched = await app.inject({
    method: 'PUT', url: '/api/routes/sample/editor/source',
    payload: {
      mode: 'editor', expectedSourceRevision: 0,
      expectedCatalogHash: initial.catalogHash,
    },
  });
  assert.equal(switched.statusCode, 200);

  const inputFile = path.join(root, 'catalog-input.json');
  await fs.writeFile(inputFile, JSON.stringify(input));
  const child = spawnSync(process.execPath, [CHILD, routesDir, inputFile, initial.catalogHash], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).code, 'routes_source_conflict');

  const scriptDir = path.join(profilesDir, 'sample', 'routes');
  await fs.mkdir(scriptDir, { recursive: true });
  const marker = path.join(root, 'script-ran');
  await fs.writeFile(path.join(scriptDir, 'publish.mjs'), [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(marker)}, "ran");`,
    'process.stdout.write(JSON.stringify({ok:true}));',
  ].join('\n'));
  const oldHttp = await app.inject({
    method: 'POST', url: '/api/routes/sample/publish',
    payload: { mode: 'publish', expectedCatalogHash: initial.catalogHash },
  });
  assert.equal(oldHttp.statusCode, 409);
  assert.equal(oldHttp.json().error, 'routes_source_conflict');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal((await store.readCurrent('sample')).catalogHash, initial.catalogHash);
});

test('RE-D2-04: source в старом HTTP body не открывает внутреннюю активацию', async (t) => {
  const { app, store } = await fixture(t);
  const input = await catalogInput(store);
  const switched = await app.inject({
    method: 'PUT', url: '/api/routes/sample/editor/source',
    payload: { mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: null },
  });
  assert.equal(switched.statusCode, 200);
  const catalog = await app.inject({
    method: 'POST', url: '/api/routes/sample/catalog',
    payload: { ...input, expectedCatalogHash: null, source: 'editor' },
  });
  assert.equal(catalog.statusCode, 400);
  const publish = await app.inject({
    method: 'POST', url: '/api/routes/sample/publish',
    payload: { mode: 'publish', source: 'editor', expectedCatalogHash: null },
  });
  assert.equal(publish.statusCode, 400);
  assert.equal(await store.readCurrent('sample'), null);
});

test('RE-D2-05: повреждённый source закрывает запись, сохраняя чтение истории', async (t) => {
  const { store, sourceFile } = await fixture(t);
  const input = await catalogInput(store);
  const current = await store.publishCatalog('sample', input, { expectedCatalogHash: null });
  await fs.writeFile(sourceFile, '{broken');
  const historical = await store.readCatalog('sample', current.catalogHash);
  assert.equal(historical.catalogHash, current.catalogHash);
  await assert.rejects(store.publishCatalog('sample', input, {
    expectedCatalogHash: current.catalogHash,
  }), { code: 'routes_authoring_corrupted' });
  await assert.rejects(store.compareAndSwapCurrent('sample', current.catalogHash, {
    expectedCatalogHash: current.catalogHash,
  }), { code: 'routes_authoring_corrupted' });
  assert.equal((await store.readCurrent('sample')).catalogHash, current.catalogHash);
});

test('RE-D2-06: rollback сохраняет source и требует точный CAS в обоих режимах', async (t) => {
  const { store } = await fixture(t);
  const firstInput = await catalogInput(store);
  const first = await store.publishCatalog('sample', firstInput, { expectedCatalogHash: null });
  const changed = makeCatalogInput();
  changed.routes.quick.route.title = 'Другая версия маршрута';
  const secondInput = await catalogInput(store, changed);
  const second = await store.publishCatalog('sample', secondInput, {
    expectedCatalogHash: first.catalogHash,
  });
  assert.notEqual(second.catalogHash, first.catalogHash);
  await store.switchEditorSource('sample', {
    mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: second.catalogHash,
  });

  const rollback = await store.compareAndSwapCurrent('sample', first.catalogHash, {
    expectedCatalogHash: second.catalogHash,
  });
  assert.equal(rollback.changed, true);
  assert.equal((await store.readCurrent('sample')).catalogHash, first.catalogHash);
  assert.deepEqual(await store.readEditorSource('sample'), { mode: 'editor', revision: 1 });
  await assert.rejects(store.compareAndSwapCurrent('sample', second.catalogHash, {
    expectedCatalogHash: second.catalogHash,
  }), { code: 'ROUTES_V2_STALE_REVISION' });

  await store.switchEditorSource('sample', {
    mode: 'profile-script', expectedSourceRevision: 1,
    expectedCatalogHash: first.catalogHash,
  });
  const restored = await store.compareAndSwapCurrent('sample', second.catalogHash, {
    expectedCatalogHash: first.catalogHash,
  });
  assert.equal(restored.changed, true);
  assert.deepEqual(await store.readEditorSource('sample'), {
    mode: 'profile-script', revision: 2,
  });
});
