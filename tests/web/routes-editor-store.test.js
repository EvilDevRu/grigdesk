import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { makeCatalogInput, makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

async function fixture(t, api) {
  globalThis.__routesEditorHarness = { api };
  const section = await compileModule(webFile('src/actions/routes/index.ts'), {
    stubs: {
      './apiClient.ts': 'export const api = globalThis.__routesEditorHarness.api;'
        + ' export const failureText = (error) => error.message;',
    },
  });
  setActivePinia(createPinia());
  const store = section.useRoutesStore();
  t.after(() => { delete globalThis.__routesEditorHarness; });
  return { store, ...section };
}

test('RE-E1-01: loadDraft держит независимые serverSnapshot и localDocument', async (t) => {
  const response = makeDraft();
  const original = structuredClone(response);
  const { store, loadDraft } = await fixture(t, {
    get: async (url) => {
      assert.equal(url, `/api/routes/sample/drafts/${response.id}`);
      return response;
    },
  });
  await loadDraft('sample', response.id);
  assert.deepEqual(store.serverSnapshot, original);
  assert.deepEqual(store.localDocument, original);
  assert.equal(store.opened.readOnly, false);
  store.localDocument.routes.quick.prompts['prompts/build.base.md'] = 'Локальная правка.\n';
  assert.deepEqual(store.serverSnapshot, original);
  assert.deepEqual(response, original);
});

test('RE-E1-02: неверный DTO и отказ GET сохраняют прежний документ с ошибкой', async (t) => {
  const valid = makeDraft();
  let result = valid;
  const { store, loadDraft, loadEditor, configureRoutesRuntime } = await fixture(t, {
    get: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  });
  await loadDraft('sample', valid.id);
  const previous = JSON.parse(JSON.stringify(store.localDocument));
  result = { ...valid, revision: 'сломано' };
  await loadDraft('sample', valid.id);
  assert.deepEqual(store.localDocument, previous);
  assert.deepEqual(store.serverSnapshot, previous);
  assert.match(store.error, /routeDraft.revision/);

  result = new Error('Сеть недоступна');
  await loadDraft('sample', valid.id);
  assert.deepEqual(store.localDocument, previous);
  assert.equal(store.error, 'Сеть недоступна');

  const editorInfo = {
    profile: 'sample', source: { mode: 'editor', revision: 1 },
    currentCatalogHash: null, capabilitiesHash: null,
    capabilities: {
      schema: 1, commands: [], contextSections: [],
      filesystem: ['state-only'], timeoutClasses: ['standard'], retryStrategies: ['none'],
    }, issues: [],
  };
  result = editorInfo;
  await loadEditor('sample');
  assert.deepEqual(store.editorInfo, editorInfo);
  result = { ...editorInfo, source: { mode: 'unknown', revision: 1 } };
  await loadEditor('sample');
  assert.deepEqual(store.editorInfo, editorInfo);
  assert.match(store.error, /routeEditorInfo.source.mode/);

  const injected = { ...makeDraft(), title: 'Ответ внедрённого API' };
  configureRoutesRuntime(store, { api: { draft: async () => injected } });
  await loadDraft('sample', injected.id);
  assert.equal(store.localDocument.title, 'Ответ внедрённого API');
});

test('RE-E1-03: поздний ответ A не заменяет B, даже при том же draftId в другом профиле',
  async (t) => {
    const deferred = () => {
      const result = {};
      result.promise = new Promise((resolve) => { result.resolve = resolve; });
      return result;
    };
    const slow = deferred();
    let currentSlow = slow;
    const initial = makeDraft();
    const other = { ...makeDraft(), title: 'Документ второго профиля', profile: 'other' };
    other.bootstrap.profile = 'other';
    other.routes.quick.route.profile = 'other';
    const { store, loadDraft, closeDraft } = await fixture(t, {
      get: async (url) => url.includes('/sample/') ? currentSlow.promise : other,
    });
    const first = loadDraft('sample', initial.id);
    const second = loadDraft('other', initial.id);
    await second;
    slow.resolve(initial);
    await first;
    assert.equal(store.opened.profile, 'other');
    assert.equal(store.localDocument.title, 'Документ второго профиля');
    assert.equal(store.serverSnapshot.profile, 'other');

    currentSlow = deferred();
    const afterClose = loadDraft('sample', initial.id);
    closeDraft();
    currentSlow.resolve(initial);
    await afterClose;
    assert.equal(store.opened, null);
    assert.equal(store.localDocument, null);
  });

test('RE-E1-04: immutable-каталог read-only, его копия становится отдельным draft', async (t) => {
  const catalogHash = 'a'.repeat(64);
  const routeHash = 'b'.repeat(64);
  const input = makeCatalogInput();
  const published = {
    catalogHash,
    catalog: {
      schema: 2, profile: 'sample', routes: { quick: routeHash },
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: input.bootstrap,
    prompts: input.bootstrapPrompts,
    manifest: { schema: 2, kind: 'catalog', profile: 'sample', algorithm: 'sha256', files: [] },
  };
  const route = {
    routeHash, route: input.routes.quick.route,
    prompts: input.routes.quick.prompts,
    manifest: { schema: 2, kind: 'route', profile: 'sample', id: 'quick',
      algorithm: 'sha256', files: [] },
  };
  const originalPublished = structuredClone(published);
  const createdDraft = makeDraft();
  createdDraft.baseCatalogHash = catalogHash;
  let posted = null;
  const { store, loadCatalog, createDraft } = await fixture(t, {
    get: async (url) => {
      if (url === `/api/routes/sample/catalog/${catalogHash}`) return published;
      if (url === `/api/routes/sample/routes/quick/${routeHash}`) return route;
      throw new Error(`Неожиданное чтение: ${url}`);
    },
    post: async (url, body) => {
      posted = { url, body };
      return createdDraft;
    },
  });
  await loadCatalog('sample', catalogHash);
  assert.deepEqual(store.opened, { profile: 'sample', catalogHash, readOnly: true });
  assert.equal(store.localDocument, null);
  assert.equal(store.publishedSnapshot.routes.quick.prompts['prompts/build.base.md'],
    'Создай проверяемый результат.\n');

  await createDraft('sample', { kind: 'catalog', title: 'Копия', catalogHash });
  assert.deepEqual(posted, {
    url: '/api/routes/sample/drafts',
    body: { kind: 'catalog', title: 'Копия', catalogHash },
  });
  assert.equal(store.opened.readOnly, false);
  assert.equal(store.opened.draftId, createdDraft.id);
  store.localDocument.routes.quick.prompts['prompts/build.base.md'] = 'Копия изменена.\n';
  assert.deepEqual(published, originalPublished);
  assert.equal(input.routes.quick.prompts['prompts/build.base.md'],
    'Создай проверяемый результат.\n');
});
