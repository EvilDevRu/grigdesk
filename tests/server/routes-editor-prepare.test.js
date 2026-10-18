import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { prepareDraftCatalog } from '../../server/src/modules/routes/publicationService.ts';
import { makeCatalogInput, makeDraft } from '../fixtures/routes-editor.mjs';

const ROUTE_TOOL = fileURLToPath(new URL('../../engine/bin/factory-route', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-editor-prepare-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new RoutesStore({ baseDir: root }) };
}

async function prepareInput(store, value = makeCatalogInput()) {
  const hashes = {};
  for (const [routeId, bundle] of Object.entries(value.routes)) {
    hashes[routeId] = (await store.publishRoute(value.profile, routeId, bundle)).routeHash;
  }
  return {
    catalog: {
      schema: 2,
      profile: value.profile,
      routes: hashes,
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: value.bootstrap,
    prompts: value.bootstrapPrompts,
  };
}

test('RE-D1-01: prepare создаёт читаемый bundle без переключения current', async (t) => {
  const { store } = await fixture(t);
  const input = await prepareInput(store);
  assert.equal(typeof store.prepareCatalog, 'function', 'операция подготовки отсутствует');
  const prepared = await store.prepareCatalog('sample', input);
  assert.match(prepared.catalogHash, /^[a-f0-9]{64}$/);
  assert.equal(prepared.created, true);
  assert.equal(await store.readCurrent('sample'), null);
  const read = await store.readCatalog('sample', prepared.catalogHash);
  assert.deepEqual(read.bootstrap, input.bootstrap);
  assert.deepEqual(read.catalog.routes, input.catalog.routes);
});

test('RE-D1-02: engine проверяет returned hash и подмену prompt до CAS', async (t) => {
  const { root, store } = await fixture(t);
  const prepared = await store.prepareCatalog('sample', await prepareInput(store));
  const check = () => spawnSync(ROUTE_TOOL, [
    '--routes-dir', root, '--profile', 'sample',
    'catalog', '--catalog-hash', prepared.catalogHash,
  ], { encoding: 'utf8' });
  assert.equal(check().status, 0);
  assert.equal(await store.readCurrent('sample'), null);
  const promptPath = path.join(root, 'sample', 'catalog', 'revisions',
    prepared.catalogHash, 'bootstrap', 'prompts', 'scout.base.md');
  await fs.writeFile(promptPath, 'Подменённый prompt.\n');
  assert.notEqual(check().status, 0);
  await assert.rejects(store.readCatalog('sample', prepared.catalogHash));
  assert.equal(await store.readCurrent('sample'), null);
});

test('RE-D1-03: отказ подготовки маршрута не двигает current', async (t) => {
  const { store } = await fixture(t);
  const old = await store.publishCatalog('sample', await prepareInput(store), {
    expectedCatalogHash: null,
  });
  const draft = makeDraft();
  draft.routes.quick.route.nodes[0].on.done = { next: 'missing' };
  await assert.rejects(prepareDraftCatalog(store, draft), {
    code: 'routes_validation_failed',
  });
  assert.equal((await store.readCurrent('sample')).catalogHash, old.catalogHash);
});

test('RE-D1-04: повтор подготовки сохраняет hash и сообщает created=false', async (t) => {
  const { store } = await fixture(t);
  const draft = makeDraft();
  const first = await prepareDraftCatalog(store, draft);
  const second = await prepareDraftCatalog(store, draft);
  assert.match(first.catalogHash, /^[a-f0-9]{64}$/);
  assert.equal(first.created, true);
  assert.equal(second.catalogHash, first.catalogHash);
  assert.equal(second.created, false);
  assert.deepEqual(second.routeHashes, first.routeHashes);
  assert.equal(await store.readCurrent('sample'), null);
});

test('RE-D1-05: старый publishCatalog сохраняет CAS и формат ответа', async (t) => {
  const { store } = await fixture(t);
  const input = await prepareInput(store);
  const first = await store.publishCatalog('sample', input, { expectedCatalogHash: null });
  assert.deepEqual(Object.keys(first).sort(), ['catalogHash', 'created', 'currentChanged']);
  assert.equal(first.created, true);
  assert.equal(first.currentChanged, true);
  const repeated = await store.publishCatalog('sample', input, { expectedCatalogHash: null });
  assert.equal(repeated.catalogHash, first.catalogHash);
  assert.equal(repeated.created, false);
  assert.equal(repeated.currentChanged, false);
  assert.equal((await store.readCurrent('sample')).catalogHash, first.catalogHash);
});
