import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

async function fixture(t, options = {}) {
  const original = makeDraft();
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const scheduler = {
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    count() { return timers.size; },
  };
  const api = {
    get: async (url) => {
      calls.push(['get', url]);
      return options.read ? options.read() : original;
    },
    post: async (url, body) => {
      calls.push(['post', url, body]);
      return options.createResponse ?? original;
    },
    patch: async (url, body) => {
      calls.push(['patch', url, body]);
      if (options.patch) return options.patch(url, body);
      return { ...original, revision: 2, title: body.operations[0].title };
    },
  };
  globalThis.__routesEditorConflictHarness = { api };
  const section = await compileModule(webFile('src/actions/routes/index.ts'), {
    stubs: {
      './apiClient.ts': 'export const api = globalThis.__routesEditorConflictHarness.api;'
        + ' export const failureText = (error) => error.message;',
    },
  });
  setActivePinia(createPinia());
  const store = section.useRoutesStore();
  section.configureRoutesRuntime(store, { scheduler });
  await section.loadDraft('sample', original.id);
  t.after(() => { delete globalThis.__routesEditorConflictHarness; });
  return { section, store, original, calls, scheduler };
}

test('RE-E4-01: PATCH 409 сохраняет буфер и останавливает автосохранение', async (t) => {
  const { section, store, calls, scheduler } = await fixture(t, {
    patch: async () => { throw Object.assign(new Error('Черновик изменился'), { status: 409 }); },
  });
  section.applyLocalChange((draft) => { draft.title = 'Мой несохранённый текст'; });
  await section.saveDraft();
  assert.equal(store.localDocument.title, 'Мой несохранённый текст');
  assert.equal(store.dirty, true);
  assert.equal(store.conflict, true);
  scheduler.tick();
  assert.equal(calls.filter((call) => call[0] === 'patch').length, 1);
});

test('RE-E4-02: отдельная копия создаётся из локального документа', async (t) => {
  const copy = { ...makeDraft(), id: '33333333-3333-4333-8333-333333333333',
    title: 'Копия моего текста' };
  const { section, store, original, calls } = await fixture(t, { createResponse: copy });
  section.applyLocalChange((draft) => {
    draft.routes.quick.prompts['prompts/build.base.md'] = 'Моя версия инструкции.\n';
  });
  await section.saveConflictCopy();
  const post = calls.find((call) => call[0] === 'post');
  assert.ok(post, 'копия должна отправить POST');
  assert.equal(post[1], '/api/routes/sample/drafts');
  assert.equal(post[2].kind, 'document');
  assert.equal(post[2].baseCatalogHash, original.baseCatalogHash);
  assert.equal(post[2].baseSourceRevision, original.baseSourceRevision);
  assert.equal(post[2].document.routes.quick.prompts['prompts/build.base.md'],
    'Моя версия инструкции.\n');
  assert.equal(store.opened.draftId, copy.id);
  assert.equal(original.routes.quick.prompts['prompts/build.base.md'],
    'Создай проверяемый результат.\n');
});

test('RE-E4-03: отмена перечитывания держит буфер, подтверждение открывает серверный',
  async (t) => {
    const server = makeDraft();
    let current = server;
    const { section, store, calls } = await fixture(t, { read: () => current });
    section.applyLocalChange((draft) => { draft.title = 'Мой буфер'; });
    current = { ...server, revision: 2, title: 'Версия сервера' };
    await section.reloadConflict(async () => false);
    assert.equal(store.localDocument.title, 'Мой буфер');
    assert.equal(calls.filter((call) => call[0] === 'get').length, 1);
    await section.reloadConflict(async () => true);
    assert.equal(store.localDocument.title, 'Версия сервера');
    assert.equal(store.serverSnapshot.revision, 2);
    assert.equal(store.dirty, false);
  });

test('RE-E4-04: собственное SSE не конфликтует, чужая revision при dirty конфликтует',
  async (t) => {
    let listener;
    let release;
    let editorReads = 0;
    const first = new Promise((resolve) => { release = resolve; });
    const { section, store, original } = await fixture(t, { patch: () => first });
    section.configureRoutesRuntime(store, {
      subscribe: (handler) => { listener = handler; return () => { listener = undefined; }; },
      api: {
        editor: async () => {
          editorReads += 1;
          return { profile: 'sample', source: { mode: 'editor', revision: 2 },
            currentCatalogHash: 'a'.repeat(64), capabilitiesHash: null,
            capabilities: { schema: 1, commands: [], contextSections: [], filesystem: [],
              timeoutClasses: [], retryStrategies: [] }, issues: [] };
        },
        drafts: async () => [],
      },
    });
    section.watchRoutes('sample');
    assert.equal(typeof listener, 'function');
    section.applyLocalChange((draft) => { draft.title = 'Мой ACK'; });
    const pending = section.saveDraft();
    listener('routes-draft-changed', {
      profile: 'sample', draftId: original.id, revision: 2, state: 'editing',
    });
    assert.equal(store.conflict, false);
    release({ ...original, revision: 2, title: 'Мой ACK' });
    await pending;
    assert.equal(store.conflict, false);
    section.applyLocalChange((draft) => { draft.title = 'Ещё локально'; });
    listener('routes-draft-changed', {
      profile: 'sample', draftId: original.id, revision: 3, state: 'editing',
    });
    assert.equal(store.conflict, true);
    listener('routes-catalog-changed', {
      profile: 'sample', catalogHash: 'a'.repeat(64), sourceRevision: 2,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(editorReads, 1);
    assert.equal(store.localDocument.title, 'Ещё локально');
  });

test('RE-E4-05: hello/focus сверяют версии, подписка одна и отписывается', async (t) => {
  const originalWindow = globalThis.window;
  const focus = new Set();
  globalThis.window = {
    addEventListener(name, listener) { if (name === 'focus') focus.add(listener); },
    removeEventListener(name, listener) { if (name === 'focus') focus.delete(listener); },
  };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const { section, store, original } = await fixture(t);
  let subscriptions = 0;
  let unsubscriptions = 0;
  let listener;
  let reads = 0;
  section.configureRoutesRuntime(store, {
    subscribe: (handler) => {
      subscriptions += 1;
      listener = handler;
      return () => { unsubscriptions += 1; listener = undefined; };
    },
    api: {
      draft: async () => { reads += 1; return { ...original, revision: 2 }; },
      editor: async () => store.editorInfo,
      drafts: async () => [],
    },
  });
  section.watchRoutes('sample');
  section.watchRoutes('sample');
  assert.equal(subscriptions, 1);
  assert.equal(focus.size, 1);
  section.applyLocalChange((draft) => { draft.title = 'Локальный текст'; });
  listener('hello', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(store.conflict, true);
  for (const callback of focus) callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  section.stopWatchingRoutes();
  section.stopWatchingRoutes();
  assert.equal(unsubscriptions, 1);
  assert.equal(focus.size, 0);
  const source = await readFile(webFile('src/composables/useSse.ts'), 'utf8');
  assert.match(source, /'routes-draft-changed'/);
  assert.match(source, /'routes-catalog-changed'/);
});

test('RE-H3-05: после hello новый current и capabilities обесценивают старые validate/compare',
  async (t) => {
    const { section, store, original } = await fixture(t);
    const previousHash = 'a'.repeat(64);
    const nextHash = 'b'.repeat(64);
    const previousCapabilities = 'c'.repeat(64);
    const nextCapabilities = 'd'.repeat(64);
    store.editorInfo = { profile: 'sample', source: { mode: 'editor', revision: 1 },
      currentCatalogHash: previousHash, capabilitiesHash: previousCapabilities };
    store.validatedRevision = original.revision;
    store.validatedGeneration = store.editGeneration;
    store.validatedCapabilitiesHash = previousCapabilities;
    store.compareReport = { draftId: original.id, draftRevision: original.revision,
      currentCatalogHash: previousHash, sourceMode: 'editor', sourceRevision: 1,
      capabilitiesHash: previousCapabilities, changes: [] };
    store.compareGeneration = store.editGeneration;
    assert.equal(store.canConfirmPublish, true);
    let listener;
    section.configureRoutesRuntime(store, { subscribe: (handler) => {
      listener = handler;
      return () => { listener = undefined; };
    }, api: {
      editor: async () => ({ profile: 'sample', source: { mode: 'editor', revision: 1 },
        currentCatalogHash: nextHash, capabilitiesHash: nextCapabilities }),
      drafts: async () => [], draft: async () => original,
    } });
    section.watchRoutes('sample');
    listener('hello', {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.editorInfo.currentCatalogHash, nextHash);
    assert.equal(store.compareReport, null);
    assert.equal(store.canPublish, false);
    assert.equal(store.canConfirmPublish, false);
    section.stopWatchingRoutes();
  });

test('RE-E4-04: чистый документ перечитывает чужую ревизию без конфликта', async (t) => {
  const original = makeDraft();
  let remote = original;
  let listener;
  const { section, store } = await fixture(t, { read: () => remote });
  section.configureRoutesRuntime(store, {
    subscribe: (handler) => { listener = handler; return () => {}; },
    api: { drafts: async () => [] },
  });
  section.watchRoutes('sample');
  remote = { ...original, revision: 2, title: 'Сохранено в соседней вкладке' };
  listener('routes-draft-changed', {
    profile: 'sample', draftId: original.id, revision: 2, state: 'editing',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.localDocument.title, 'Сохранено в соседней вкладке');
  assert.equal(store.conflict, false);
  section.stopWatchingRoutes();
});
