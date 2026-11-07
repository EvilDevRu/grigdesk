import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

function fakeScheduler() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delayMs) {
      const id = ++sequence;
      timers.set(id, { when: now + delayMs, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.when <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    count() { return timers.size; },
  };
}

async function fixture(t, patch) {
  const response = makeDraft();
  const scheduler = fakeScheduler();
  const calls = [];
  globalThis.__routesEditorSaveHarness = {
    api: {
      get: async () => response,
      patch: async (url, body) => {
        calls.push({ url, body });
        return patch ? patch(response, body) : { ...response, revision: response.revision + 1 };
      },
    },
  };
  const section = await compileModule(webFile('src/actions/routes/index.ts'), {
    stubs: {
      './apiClient.ts': 'export const api = globalThis.__routesEditorSaveHarness.api;'
        + ' export const failureText = (error) => error.message;',
    },
  });
  setActivePinia(createPinia());
  const store = section.useRoutesStore();
  section.configureRoutesRuntime(store, { scheduler });
  await section.loadDraft('sample', response.id);
  t.after(() => { delete globalThis.__routesEditorSaveHarness; });
  return { store, section, response, scheduler, calls };
}

test('RE-E3-01: debounce шлёт один PATCH с последним изменённым документом', async (t) => {
  const { section, scheduler, calls, response } = await fixture(t);
  section.applyLocalChange((draft) => { draft.title = 'Первое'; });
  scheduler.advance(300);
  section.applyLocalChange((draft) => { draft.title = 'Второе'; });
  scheduler.advance(200);
  section.applyLocalChange((draft) => {
    draft.title = 'Итог';
    draft.routes.quick.prompts['prompts/build.base.md'] = 'Новая инструкция.\n';
  });
  scheduler.advance(799);
  assert.equal(calls.length, 0);
  scheduler.advance(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    url: `/api/routes/sample/drafts/${response.id}`,
    body: {
      expectedRevision: response.revision,
      operations: [
        { kind: 'setTitle', title: 'Итог' },
        { kind: 'putRoute', routeId: 'quick',
          route: response.routes.quick.route,
          prompts: { ...response.routes.quick.prompts,
            'prompts/build.base.md': 'Новая инструкция.\n' } },
      ],
    },
  }]);
});

test('RE-E3-02: поздний ACK меняет baseline, но сохраняет более свежий ввод', async (t) => {
  let releaseFirst;
  let patchNumber = 0;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const { section, store, scheduler, calls, response } = await fixture(t,
    (original) => {
      patchNumber += 1;
      if (patchNumber === 1) return first;
      return { ...original, revision: 3, title: 'Второй текст' };
    });
  section.applyLocalChange((draft) => { draft.title = 'Первый текст'; });
  const pending = section.saveDraft();
  assert.equal(store.inFlightGeneration, 1);
  section.applyLocalChange((draft) => { draft.title = 'Второй текст'; });
  releaseFirst({ ...response, revision: 2, title: 'Первый текст' });
  await pending;
  assert.equal(store.serverSnapshot.title, 'Первый текст');
  assert.equal(store.serverSnapshot.revision, 2);
  assert.equal(store.localDocument.title, 'Второй текст');
  assert.equal(store.localDocument.revision, 2);
  assert.equal(store.dirty, true);
  scheduler.advance(800);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, {
    expectedRevision: 2, operations: [{ kind: 'setTitle', title: 'Второй текст' }],
  });
  assert.equal(store.dirty, false);
});

test('RE-E3-03: два явных сохранения держат один in-flight PATCH', async (t) => {
  let release;
  const reply = new Promise((resolve) => { release = resolve; });
  const { section, store, response, calls } = await fixture(t, () => reply);
  section.applyLocalChange((draft) => { draft.title = 'Один ввод'; });
  const first = section.saveDraft();
  const second = section.saveDraft();
  assert.equal(calls.length, 1);
  assert.equal(store.saving, true);
  release({ ...response, revision: 2, title: 'Один ввод' });
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(store.saving, false);
  assert.equal(store.dirty, false);
});

test('RE-E3-04: отказ сети оставляет dirty и текст до явного повтора', async (t) => {
  let fail = true;
  const { section, store, response, scheduler, calls } = await fixture(t,
    (original) => {
      if (fail) throw new Error('Сеть недоступна');
      return { ...original, revision: 2, title: 'Несохранённый текст' };
    });
  section.applyLocalChange((draft) => { draft.title = 'Несохранённый текст'; });
  scheduler.advance(800);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.localDocument.title, 'Несохранённый текст');
  assert.equal(store.serverSnapshot.revision, response.revision);
  assert.equal(store.dirty, true);
  assert.equal(store.saveError, 'Сеть недоступна');
  assert.equal(calls.length, 1);
  scheduler.advance(800);
  assert.equal(calls.length, 1);
  fail = false;
  await section.saveDraft();
  assert.equal(calls.length, 2);
  assert.equal(store.saveError, '');
  assert.equal(store.dirty, false);
});

test('RE-E3-05: закрытие снимает timer, а старый ACK не блокирует новый draft',
  async (t) => {
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    const second = { ...makeDraft(), id: '22222222-2222-4222-8222-222222222222',
      title: 'Другой черновик' };
    const { section, store, response, scheduler, calls } = await fixture(t,
      (original, body) => body.expectedRevision === 1 && calls.length === 1
        ? first : { ...second, revision: 2, title: 'Второй сохранён' });
    section.applyLocalChange((draft) => { draft.title = 'Таймер'; });
    assert.equal(scheduler.count(), 1);
    section.closeDraft();
    assert.equal(scheduler.count(), 0);
    scheduler.advance(800);
    assert.equal(calls.length, 0);

    await section.loadDraft('sample', response.id);
    section.applyLocalChange((draft) => { draft.title = 'Первый в пути'; });
    const oldSave = section.saveDraft();
    section.configureRoutesRuntime(store, { api: { draft: async () => second } });
    await section.loadDraft('sample', second.id);
    section.applyLocalChange((draft) => { draft.title = 'Второй сохранён'; });
    const newSave = section.saveDraft();
    assert.equal(calls.length, 2);
    releaseFirst({ ...response, revision: 2, title: 'Первый в пути' });
    await Promise.all([oldSave, newSave]);
    assert.equal(store.opened.draftId, second.id);
    assert.equal(store.localDocument.title, 'Второй сохранён');
    assert.equal(store.serverSnapshot.revision, 2);
  });

test('RE-E5-06: пустая инструкция сохраняется, но диагностика не разрешает публикацию',
  async (t) => {
    const { section, store, calls, response } = await fixture(t, (original) => ({
      ...original, revision: 2,
      routes: { ...original.routes, quick: { ...original.routes.quick,
        prompts: { ...original.routes.quick.prompts, 'prompts/build.base.md': '' } } },
    }));
    section.configureRoutesRuntime(store, { api: { validateDraft: async () => ({
      draftId: response.id, draftRevision: 2, capabilitiesHash: null,
      issues: [{ code: 'prompt_required', severity: 'error', scope: 'route',
        routeId: 'quick', nodeId: 'build', path: '/routes/quick/prompts/build.base.md',
        message: 'Инструкция обязательна' }],
    }) } });
    section.applyLocalChange((draft) => {
      draft.routes.quick.prompts['prompts/build.base.md'] = '';
    });
    await section.saveDraft();
    assert.equal(calls[0].body.operations[0].prompts['prompts/build.base.md'], '');
    assert.equal(store.serverSnapshot.routes.quick.prompts['prompts/build.base.md'], '');
    await section.validateDraft();
    assert.equal(store.validationIssues[0].code, 'prompt_required');
    assert.equal(store.canPublish, false);
  });
