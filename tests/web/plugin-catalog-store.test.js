import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { catalogFixture } from '../helpers/pluginCatalog.js';

test('CAT-W1: checked response, stale при отказе и поздний detail после dispose', async (t) => {
  const module = await compileModule(webFile('src/stores/pluginCatalog.ts'));
  const fixture = catalogFixture();
  let fail = false;
  let finish;
  const detailBarrier = new Promise((resolve) => {
    finish = resolve;
  });
  const store = module.definePluginCatalogStore({
    get: async (url) => {
      if (fail) {
        return { state: 'fresh', catalog: {} };
      }

      return url.includes('/demo') ? detailBarrier : {
        state: 'fresh',
        applicationVersion: '1.0.0',
        fetchedAt: fixture.index.generatedAt,
        catalog: fixture.index,
      };
    },
  }, 'catalog-fixture')(createPinia());

  t.after(() => store.$dispose());
  await store.loadIndex();
  assert.equal(store.state, 'fresh');
  assert.equal(store.index.plugins[0].id, 'demo');
  fail = true;
  await store.loadIndex(true);
  assert.equal(store.state, 'stale');
  assert.equal(store.index.plugins[0].id, 'demo');
  fail = false;
  await store.loadIndex(true);


  const pending = store.loadDetail('demo');

  assert.equal(store.detailLoading, true);
  store.$dispose();
  finish(fixture.detail);
  await pending;
  assert.equal(store.detail, null);
});

test('CAT-W2: detail неверного snapshot или прежнего выбора не публикуется', async (t) => {
  const module = await compileModule(webFile('src/stores/pluginCatalog.ts'));
  const fixture = catalogFixture();
  let finish;
  const delayed = new Promise((resolve) => {
    finish = resolve;
  });
  const store = module.definePluginCatalogStore({
    get: async (url) => url.includes('/demo') ? delayed : {
      state: 'fresh',
      applicationVersion: '1.0.0',
      fetchedAt: fixture.index.generatedAt,
      catalog: fixture.index,
    },
  }, 'catalog-switch')(createPinia());

  t.after(() => store.$dispose());
  await store.loadIndex();


  const first = store.loadDetail('demo');

  await store.loadDetail('missing');
  finish(fixture.detail);
  await first;
  assert.equal(store.selectedId, 'missing');
  assert.equal(store.detail, null);
  assert.equal(store.detailError, true);
});

test('CAT-W3: старый index не откатывает явный refresh', async (t) => {
  const module = await compileModule(webFile('src/stores/pluginCatalog.ts'));
  const fixture = catalogFixture();
  let release;
  let count = 0;
  const old = new Promise((resolve) => {
    release = resolve;
  });
  const fresh = {
    state: 'fresh',
    applicationVersion: '1.0.0',
    fetchedAt: fixture.index.generatedAt,
    catalog: fixture.index,
  };
  const store = module.definePluginCatalogStore({
    get: async () => {
      count += 1;

      return count === 1 ? old : fresh;
    },
  }, 'catalog-refresh')(createPinia());

  t.after(() => store.$dispose());


  const first = store.loadIndex();

  await store.loadIndex(true);
  release({ ...fresh, catalog: { ...fixture.index, plugins: [] } });
  await first;
  assert.equal(store.index.plugins.length, 1);
});

test('CAT-W5: detail со старого снимка, начатый во время refresh, не публикуется', async (t) => {
  const module = await compileModule(webFile('src/stores/pluginCatalog.ts'));
  const fixture = catalogFixture();
  let completeIndex;
  let completeDetail;
  const nextIndex = new Promise((resolve) => {
    completeIndex = resolve;
  });
  const oldDetail = new Promise((resolve) => {
    completeDetail = resolve;
  });
  const original = {
    state: 'fresh',
    applicationVersion: '1.0.0',
    fetchedAt: fixture.index.generatedAt,
    catalog: fixture.index,
  };
  const store = module.definePluginCatalogStore({
    get: async (url) => url.includes('/demo') ? oldDetail
      : url.includes('refresh=1') ? nextIndex : original,
  }, 'catalog-during-refresh')(createPinia());

  t.after(() => store.$dispose());
  await store.loadIndex();


  const refreshing = store.loadIndex(true);
  const reading = store.loadDetail('demo');
  const next = structuredClone(original);

  next.catalog.generatedAt = '2026-10-22T12:00:00.000Z';
  completeIndex(next);
  await refreshing;
  completeDetail(fixture.detail);
  await reading;
  assert.equal(store.detail, null);
  assert.equal(store.detailError, true, 'карточка нового снимка не исчезает молча');
  assert.equal(store.index.generatedAt, next.catalog.generatedAt);
});

test('CAT-W6: карточка, сброшенная новым снимком, просит обновить каталог', async (t) => {
  const module = await compileModule(webFile('src/stores/pluginCatalog.ts'));
  const fixture = catalogFixture();
  const original = {
    state: 'fresh',
    applicationVersion: '1.0.0',
    fetchedAt: fixture.index.generatedAt,
    catalog: fixture.index,
  };
  const next = structuredClone(original);
  let current = original;

  next.catalog.generatedAt = '2026-10-22T12:00:00.000Z';

  const store = module.definePluginCatalogStore({
    get: async (url) => url.includes('/demo') ? fixture.detail : current,
  }, 'catalog-dropped')(createPinia());

  t.after(() => store.$dispose());
  await store.loadIndex();
  await store.loadDetail('demo');
  await store.loadIndex(true);
  assert.equal(store.detail.plugin.id, 'demo', 'тот же снимок сохраняет карточку');
  assert.equal(store.detailError, false);
  current = next;
  await store.loadIndex(true);
  assert.equal(store.detail, null);
  assert.equal(store.detailError, true);
  await store.loadDetail('demo');
  assert.equal(store.detailError, true, 'карточка старого снимка не публикуется');
});
