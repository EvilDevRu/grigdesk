import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { catalogFixture } from '../helpers/pluginCatalog.js';
import { moduleCatalogFixture, catalogResponse } from '../helpers/pluginCatalogModules.js';
import { ApiError } from '../../web/src/shared/apiClient.ts';

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


test('CAT-W7-MIXED: единый same-origin каталог api1/2, refresh, detail и точный SHA', async (t) => {
  const module = await compileModule(webFile('src/stores/pluginCatalog.ts'));
  const modules = moduleCatalogFixture();
  const calls = [];
  const store = module.definePluginCatalogStore({
    get: async (url, options) => {
      calls.push({ url, timeoutMs: options.timeoutMs });

      return url.includes('/demo') ? modules.detail : catalogResponse(modules);
    },
  }, 'catalog-modules')(createPinia());

  t.after(() => store.$dispose());
  await store.loadIndex();
  assert.equal(store.state, 'fresh');
  assert.equal(store.index.plugins[0].latest.api, 2);
  await store.loadIndex(true);
  await store.loadDetail('demo');
  assert.equal(store.detail.plugin.versions[0].sha, modules.version.sha);
  assert.deepEqual(calls, [
    { url: '/api/plugin-catalog', timeoutMs: 20000 },
    { url: '/api/plugin-catalog?refresh=1', timeoutMs: 20000 },
    { url: '/api/plugin-catalog/demo', timeoutMs: 15000 },
  ]);
});

for (const [label, failure] of [
  ['400', new ApiError('Некорректный запрос', 400, {})],
  ['401', new ApiError('Сессия истекла', 401, {})],
  ['503', new ApiError('Временно недоступно', 503, {})],
  ['невалидный 200', null],
  ['cancel', new DOMException('Отменено', 'AbortError')],
]) {
  test(`CAT-W9-FAILURE: ${label} завершает единственный запрос ошибкой`, async (t) => {
    const module = await compileModule(webFile('src/stores/pluginCatalog.ts'));
    const calls = [];
    const store = module.definePluginCatalogStore({
      get: async (url) => {
        calls.push(url);

        if (failure) {
          throw failure;
        }

        return { state: 'fresh', catalog: {} };
      },
    }, `catalog-failure-${label}`)(createPinia());

    t.after(() => store.$dispose());
    await store.loadIndex();
    assert.equal(store.state, 'unavailable');
    assert.equal(store.error, true);
    assert.deepEqual(calls, ['/api/plugin-catalog']);
  });
}

test('CAT-W9-FAILURE: поздний HTTP400 старого epoch не меняет новый снимок', async (t) => {
  const module = await compileModule(webFile('src/stores/pluginCatalog.ts'));
  const modules = moduleCatalogFixture();
  const old = Promise.withResolvers();
  const calls = [];
  const store = module.definePluginCatalogStore({
    get: async (url) => {
      calls.push(url);

      if (calls.length === 1) {
        return old.promise;
      }

      return url.includes('/demo') ? modules.detail : catalogResponse(modules);
    },
  }, 'catalog-late-400')(createPinia());

  t.after(() => store.$dispose());

  const pending = store.loadIndex();

  await store.loadIndex(true);
  old.reject(new ApiError('Старая проба', 400, {}));
  await pending;
  await store.loadDetail('demo');
  assert.equal(store.state, 'fresh');
  assert.equal(store.detail.plugin.versions[0].sha, modules.version.sha);
  assert.deepEqual(calls, ['/api/plugin-catalog', '/api/plugin-catalog?refresh=1',
    '/api/plugin-catalog/demo']);
});

test('CAT-W9-FAILURE: HTTP400 после dispose не запускает новый запрос', async () => {
  const module = await compileModule(webFile('src/stores/pluginCatalog.ts'));
  const pending = Promise.withResolvers();
  const calls = [];
  const store = module.definePluginCatalogStore({
    get: async (url) => {
      calls.push(url);

      return pending.promise;
    },
  }, 'catalog-disposed-400')(createPinia());
  const reading = store.loadIndex();

  store.$dispose();
  pending.reject(new ApiError('Закрыто', 400, {}));
  await reading;
  assert.deepEqual(calls, ['/api/plugin-catalog']);
  assert.equal(store.index, null);
});

test('CAT-V1-MEDIA-ROUNDTRIP: store принимает проверенный media detail того же SHA', async (t) => {
  const module = await compileModule(webFile('src/stores/pluginCatalog.ts'));
  const data = catalogFixture();
  const icon = {
    path: 'assets/icon.png',
    sha: data.version.sha,
    mediaType: 'image/png',
    bytes: 1024
  };

  data.detail.plugin.icon = icon;
  data.detail.plugin.gallery = { screenshots: [{ ...icon, path: 'assets/screen.png' }] };

  const store = module.definePluginCatalogStore({
    get: async (url) => url.includes('/demo') ? data.detail : {
      state: 'fresh',
      applicationVersion: '1.0.0',
      fetchedAt: data.index.generatedAt,
      catalog: data.index,
    },
  }, 'catalog-v1-media')(createPinia());

  t.after(() => store.$dispose());
  await store.loadIndex();
  await store.loadDetail('demo');
  assert.equal(store.detailError, false);
  assert.deepEqual(store.detail.plugin.icon, icon);
  assert.deepEqual(store.detail.plugin.gallery, data.detail.plugin.gallery);
  assert.equal(store.detail.plugin.readme, data.detail.plugin.readme);
});
