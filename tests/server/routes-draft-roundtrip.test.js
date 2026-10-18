import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeCatalogInput, makeDraft } from '../fixtures/routes-editor.mjs';
import {
  draftFromCatalog,
  toRuntimeCatalogInput,
} from '../../server/src/modules/routes/draftModel.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { projectRouteCatalog } from '../../shared/pipeline/routeProjection.ts';

const META = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Копия опубликованного каталога',
  baseSourceRevision: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/**
 * Публикует только синтетические документы во временном хранилище и читает их обратно.
 * В тестах сравниваются реально вычисленные store хеши, а не копия алгоритма хеширования.
 */
async function publishedFixture(t, input = makeCatalogInput()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-routes-roundtrip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RoutesStore({ baseDir: path.join(root, 'routes') });
  const routeHashes = {};

  for (const [routeId, bundle] of Object.entries(input.routes)) {
    const result = await store.publishRoute(input.profile, routeId, bundle);
    routeHashes[routeId] = result.routeHash;
  }
  const catalogResult = await store.publishCatalog(input.profile, {
    catalog: {
      schema: 2,
      profile: input.profile,
      routes: routeHashes,
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: input.bootstrap,
    prompts: input.bootstrapPrompts,
  }, { expectedCatalogHash: null });
  const catalog = await store.readCatalog(input.profile, catalogResult.catalogHash);
  const routes = {};

  for (const [routeId, routeHash] of Object.entries(catalog.catalog.routes)) {
    routes[routeId] = await store.readRoute(input.profile, routeId, routeHash);
  }

  return { store, input, routeHashes, catalogResult, bundleSet: { catalog, routes } };
}

test('RE-A4-01: опубликованный каталог проходит draft и повторную публикацию без смены хешей',
  async (t) => {
    const { store, input, routeHashes, catalogResult, bundleSet } = await publishedFixture(t);
    const draft = draftFromCatalog(bundleSet, META);
    const runtime = toRuntimeCatalogInput(draft);

    assert.equal(runtime.ok, true);

    const repeatedRoutes = {};
    for (const [routeId, bundle] of Object.entries(runtime.input.routes)) {
      const result = await store.publishRoute(input.profile, routeId, bundle);
      repeatedRoutes[routeId] = result.routeHash;
    }
    const repeatedCatalog = await store.publishCatalog(input.profile, {
      catalog: {
        schema: 2,
        profile: input.profile,
        routes: repeatedRoutes,
        bootstrap: { file: 'bootstrap/scout.json' },
      },
      bootstrap: runtime.input.bootstrap,
      prompts: runtime.input.bootstrapPrompts,
    }, { expectedCatalogHash: catalogResult.catalogHash });

    assert.deepEqual(repeatedRoutes, routeHashes);
    assert.equal(repeatedCatalog.catalogHash, catalogResult.catalogHash);
    assert.equal(repeatedCatalog.currentChanged, false);
  });

test('RE-A4-02: раскладка не меняет route hash, текст инструкции меняет его', async (t) => {
  const { store, input, routeHashes, bundleSet } = await publishedFixture(t);
  const draft = draftFromCatalog(bundleSet, META);
  draft.presentation.quick = { build: { x: 200, y: 100 } };

  const moved = toRuntimeCatalogInput(draft);
  assert.equal(moved.ok, true);
  const unchanged = await store.publishRoute(input.profile, 'quick', moved.input.routes.quick);
  assert.equal(unchanged.routeHash, routeHashes.quick);

  draft.routes.quick.prompts['prompts/build.base.md'] += 'Добавь итог проверки.\n';
  const changed = toRuntimeCatalogInput(draft);
  assert.equal(changed.ok, true);
  const revised = await store.publishRoute(input.profile, 'quick', changed.input.routes.quick);
  assert.notEqual(revised.routeHash, routeHashes.quick);
});

test('RE-A4-03: одинаковый node ID в двух маршрутах не сталкивается на графе', () => {
  const draft = makeDraft();
  draft.routes.audit = structuredClone(draft.routes.quick);
  draft.routes.audit.route.id = 'audit';

  const graph = projectRouteCatalog(draft);
  const buildIds = Object.values(graph.routes).flatMap((route) => (
    route.nodes.filter((node) => node.origin.nodeId === 'build').map((node) => node.id)
  ));

  assert.deepEqual(new Set(buildIds), new Set(['r:quick:build', 'r:audit:build']));
  assert.ok(graph.bootstrap.nodes.some((node) => node.id === 'b:scout'));
});

test('RE-A4-04: bootstrap берётся из выбранной ревизии, даже если current уже новый', async (t) => {
  const { store, input, catalogResult, bundleSet } = await publishedFixture(t);
  const newPrompts = {
    ...input.bootstrapPrompts,
    'bootstrap/prompts/scout.base.md': 'Обновлённая разведка.\n',
  };
  const newer = await store.publishCatalog(input.profile, {
    catalog: bundleSet.catalog.catalog,
    bootstrap: input.bootstrap,
    prompts: newPrompts,
  }, { expectedCatalogHash: catalogResult.catalogHash });
  const current = await store.readCurrent(input.profile);
  const draft = draftFromCatalog(bundleSet, META);

  assert.equal(current.catalogHash, newer.catalogHash);
  assert.notEqual(current.catalogHash, draft.baseCatalogHash);
  assert.equal(draft.bootstrapPrompts['bootstrap/prompts/scout.base.md'],
    input.bootstrapPrompts['bootstrap/prompts/scout.base.md']);
});

test('RE-A4-05: status, onFailure, optional fields и CRLF переживают roundtrip', async (t) => {
  const input = makeCatalogInput();
  const check = input.routes.quick.route.nodes.find((node) => node.id === 'check');
  check.label = 'Проверка';
  check.description = 'Синтетическая команда';
  check.onFailure = {
    build: { rewind: 'build', reset: ['build', 'check'] },
    tests: { stop: 'human' },
    environment: { stop: 'human' },
    plan: { stop: 'human' },
    human: { stop: 'human' },
  };
  input.routes.quick.prompts['prompts/build.base.md'] = 'Первая строка\r\nВторая строка\r\n';
  const { store, routeHashes, bundleSet } = await publishedFixture(t, input);
  const draft = draftFromCatalog(bundleSet, META);
  const restoredCheck = draft.routes.quick.route.nodes.find((node) => node.id === 'check');

  assert.deepEqual(restoredCheck.onFailure, check.onFailure);
  assert.equal(restoredCheck.label, 'Проверка');
  assert.equal(restoredCheck.description, 'Синтетическая команда');
  assert.deepEqual(draft.routes.quick.route.nodes.find((node) => node.id === 'check_status'), {
    id: 'check_status',
    executor: 'status',
    phase: 'main',
    key: 'CHECK_STATUS',
    owner: 'check',
  });
  assert.equal(draft.routes.quick.prompts['prompts/build.base.md'], 'Первая строка\nВторая строка\n');
  const runtime = toRuntimeCatalogInput(draft);
  assert.equal(runtime.ok, true);
  const repeated = await store.publishRoute(input.profile, 'quick', runtime.input.routes.quick);
  assert.equal(repeated.routeHash, routeHashes.quick);
});
