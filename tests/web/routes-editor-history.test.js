import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { cloneNodes, removeNodes } from '../../web/src/views/routes/routeCommands.ts';
import { historyShortcut } from '../../web/src/actions/routes/history.ts';

process.env.NODE_ENV = 'test';

function scheduler() {
  const timers = new Map();
  let id = 0;
  return {
    setTimeout(callback) { timers.set(++id, callback); return id; },
    clearTimeout(key) { timers.delete(key); },
    flush() { for (const [key, callback] of [...timers]) { timers.delete(key); callback(); } },
  };
}

async function fixture(t) {
  const original = makeDraft();
  const requests = [];
  const clock = scheduler();
  globalThis.__routeHistoryHarness = { api: {
    get: async () => original,
    patch: async (url, body) => {
      requests.push({ url, body });
      const next = structuredClone(original);
      next.revision = body.expectedRevision + 1;
      for (const operation of body.operations) {
        if (operation.kind === 'setTitle') next.title = operation.title;
        if (operation.kind === 'putRoute') next.routes[operation.routeId] = {
          route: operation.route, prompts: operation.prompts,
        };
        if (operation.kind === 'removeRoute') delete next.routes[operation.routeId];
        if (operation.kind === 'putBootstrap') {
          next.bootstrap = operation.bootstrap;
          next.bootstrapPrompts = operation.prompts;
        }
        if (operation.kind === 'putPresentation') next.presentation = operation.presentation;
        if (operation.kind === 'putProvenance') next.provenance = operation.provenance;
      }
      return next;
    },
  } };
  const actions = await compileModule(webFile('src/actions/routes/index.ts'), { stubs: {
    './apiClient.ts': 'export const api = globalThis.__routeHistoryHarness.api;'
      + ' export const failureText = (error) => error.message;',
  } });
  setActivePinia(createPinia());
  const store = actions.useRoutesStore();
  actions.configureRoutesRuntime(store, { scheduler: clock });
  await actions.loadDraft('sample', original.id);
  t.after(() => { delete globalThis.__routeHistoryHarness; });
  return { actions, store, original, clock, requests };
}

const scope = { kind: 'route', routeId: 'quick' };
const allocateCopy = (suggested) => `${suggested}_COPY`;

test('RE-F6-01: clone/delete группы откатывают узлы, инструкции и ссылки целиком', async (t) => {
  const { actions, store, original } = await fixture(t);
  actions.applyLocalChange((draft) => {
    const result = cloneNodes(draft, scope, ['build', 'check'], allocateCopy);
    Object.assign(draft, result.draft);
  });
  const cloned = JSON.parse(JSON.stringify(store.localDocument));
  assert.equal(cloned.routes.quick.route.nodes.length, original.routes.quick.route.nodes.length + 2);
  assert.ok(Object.hasOwn(cloned.routes.quick.prompts, 'prompts/build_copy.base.md'));
  assert.deepEqual(cloned.routes.quick.route.nodes.find((node) => node.id === 'build_copy').on.done,
    { next: 'check_copy' });
  assert.equal(actions.undoDraft(), true);
  assert.deepEqual(store.localDocument.routes.quick, original.routes.quick);
  assert.equal(actions.redoDraft(), true);
  assert.deepEqual(store.localDocument.routes.quick, cloned.routes.quick);

  actions.applyLocalChange((draft) => {
    const result = removeNodes(draft, scope, ['build_copy', 'check_copy']);
    Object.assign(draft, result.draft);
  });
  assert.equal(actions.undoDraft(), true);
  assert.deepEqual(store.localDocument.routes.quick, cloned.routes.quick);
});

test('RE-F6-02: новая команда после undo отбрасывает старую ветку redo', async (t) => {
  const { actions, store } = await fixture(t);
  actions.applyLocalChange((draft) => { draft.title = 'Первая'; });
  actions.applyLocalChange((draft) => { draft.title = 'Вторая'; });
  assert.equal(actions.undoDraft(), true);
  assert.equal(store.localDocument.title, 'Первая');
  assert.equal(store.historyFuture.length, 1);
  actions.applyLocalChange((draft) => { draft.title = 'Новая ветка'; });
  assert.equal(actions.redoDraft(), false);
  assert.equal(store.historyFuture.length, 0);
  assert.equal(store.localDocument.title, 'Новая ветка');
});

test('RE-F6-03: ACK не стирает историю; undo создаёт правку поверх новой ревизии', async (t) => {
  const { actions, store, original, requests } = await fixture(t);
  actions.applyLocalChange((draft) => { draft.title = 'Сохранённое название'; });
  await actions.saveDraft();
  assert.equal(store.serverSnapshot.revision, original.revision + 1);
  assert.equal(store.historyPast.length, 1);
  assert.equal(store.dirty, false);
  const opened = JSON.parse(JSON.stringify(store.opened));
  assert.equal(actions.undoDraft(), true);
  assert.equal(store.localDocument.title, original.title);
  assert.equal(store.localDocument.revision, original.revision + 1);
  assert.equal(store.serverSnapshot.title, 'Сохранённое название');
  assert.equal(store.serverSnapshot.revision, original.revision + 1);
  assert.deepEqual(store.opened, opened);
  assert.equal(store.dirty, true);
  await actions.saveDraft();
  assert.equal(requests[1].body.expectedRevision, original.revision + 1);
  assert.deepEqual(requests[1].body.operations, [{ kind: 'setTitle', title: original.title }]);
  assert.equal(store.serverSnapshot.revision, original.revision + 2);
  assert.equal(store.dirty, false);
});

test('RE-F6-04: текстовая сессия — одна запись; фокус и клавиши Monaco не трогают историю',
  async (t) => {
    const { actions, store, original } = await fixture(t);
    const file = 'prompts/build.base.md';
    const group = `prompt:quick:${file}`;
    const before = store.historyPast.length;
    assert.equal(historyShortcut({ key: 'z', ctrlKey: true, metaKey: false,
      shiftKey: false, altKey: false,
      target: { closest: () => ({ className: 'monaco-editor' }) } }), null);
    assert.equal(store.historyPast.length, before);
    actions.applyLocalChange((draft) => { draft.routes.quick.prompts[file] = 'П'; },
      { historyGroup: group });
    actions.applyLocalChange((draft) => { draft.routes.quick.prompts[file] = 'Пр'; },
      { historyGroup: group });
    assert.equal(store.historyPast.length, before + 1);
    actions.endHistoryGroup();
    assert.equal(actions.undoDraft(), true);
    assert.equal(store.localDocument.routes.quick.prompts[file], original.routes.quick.prompts[file]);
    assert.equal(actions.redoDraft(), true);
    assert.equal(store.localDocument.routes.quick.prompts[file], 'Пр');
    actions.applyLocalChange((draft) => { draft.routes.quick.prompts[file] = 'Про'; },
      { historyGroup: group });
    assert.equal(store.historyPast.length, before + 2);
  });

test('RE-F6-05: 101 команд хранят последние 100 без изменения serverSnapshot', async (t) => {
  const { actions, store, original } = await fixture(t);
  for (let index = 1; index <= 101; index++) {
    actions.applyLocalChange((draft) => { draft.title = `Изменение ${index}`; });
  }
  assert.equal(store.historyPast.length, 100);
  assert.equal(store.historyFuture.length, 0);
  assert.equal(store.historyPast[0].title, 'Изменение 1');
  assert.equal(store.serverSnapshot.title, original.title);
  assert.equal(store.serverSnapshot.revision, original.revision);
  for (let index = 0; index < 100; index++) assert.equal(actions.undoDraft(), true);
  assert.equal(store.localDocument.title, 'Изменение 1');
  assert.equal(actions.undoDraft(), false);
  assert.equal(store.serverSnapshot.title, original.title);
});
