import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, disposePinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { reactive } from '../../web/node_modules/vue/index.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

let serial = 0;

/**
 * Полный снимок проходит настоящий parser полки, включая все три источника.
 * Постоянные времена не создают ложного перехода в огонь между ответами.
 */
function entry(taskId) {
  return {
    taskId,
    title: 'Задача ' + taskId,
    addedAt: '2026-08-26T08:00:00.000Z',
    reason: 'manual',
    snapshot: {
      analysis: null,
      pipeline: {
        attempt: 'a1',
        daemon: 'running',
        result: null,
        stall: null,
        gateKnown: true,
        gate: null,
      },
      b24: {
        present: true,
        status: 'IN_PROGRESS',
        statusKind: 'active',
        unread: 0,
      },
    },
  };
}

/**
 * Каждый документ получает свой Pinia и свои источники, а сеть хранит полные снимки.
 * GET деталей и оповещения наблюдаемы даже без запуска фонового start.
 */
async function shelfFixture(t, ids = ['11', '99']) {
  const key = '__surfaceShelf' + ++serial;
  const pinia = createPinia();
  const state = {
    scope: 'fixture',
    revision: 1,
    entries: ids.map(entry),
  };
  const h = {
    calls: [],
    alerts: [],
    analysis: reactive({
      loadedAt: 0,
      error: null,
      byTask: {},
    }),
    pipeline: reactive({
      loadedAt: 0,
      error: null,
      observedByTask: {},
    }),
    board: reactive({
      loadedAt: 1,
      error: null,
      data: {
        tasks: [{
          id: 11,
          group: '',
          status: 'IN_PROGRESS',
          statusKind: 'active',
          unread: 0,
        }],
        toReview: [],
        created: [],
        accomplice: [],
        auditor: [],
      },
    }),
    plugins: {
      loaded: true,
      enabled: () => true,
      byId: () => ({ values: { browserNotifications: true } }),
    },
  };

  h.api = {
    async get(url) {
      h.calls.push({ method: 'GET', url });

      return url === '/api/tracker/task-shelf'
        ? structuredClone(state)
        : { title: 'Полная карточка', group_name: 'Проект' };
    },
    /**
     * Мутация меняет только свою запись и возвращает полный снимок новой ревизии.
     * Acknowledge копирует присланную базу, не сочиняя observed на стороне фикстуры.
     */
    async put(url, body) {
      const id = url.split('/').at(-1);

      h.calls.push({
        method: 'PUT',
        url,
        body: structuredClone(body),
      });
      state.revision += 1;

      const old = state.entries.find((item) => item.taskId === id);

      if (old) {
        old.snapshot = structuredClone(body.snapshot);
      } else if (body.createIfMissing) {
        state.entries.push({
          ...entry(id),
          title: body.title,
          snapshot: structuredClone(body.snapshot),
        });
      }

      return structuredClone(state);
    },
    /**
     * Удаление сохраняет остальные записи и повышает ревизию серверного снимка.
     * Потребители видят подтверждённый ответ, а не оптимистическое локальное удаление.
     */
    async del(url) {
      h.calls.push({ method: 'DELETE', url });
      state.revision += 1;
      state.entries = state.entries.filter((item) => item.taskId !== url.split('/').at(-1));

      return structuredClone(state);
    },
  };
  globalThis[key] = h;

  const module = await compileModule(webFile('src/stores/taskShelf.ts'), {
    stubs: {
      '../shared/apiClient.ts': `export const api = globalThis.${key}.api;`,
      './apiClient.ts': `export const api = globalThis.${key}.api;`,
      '../shared/alerts.ts': `export const alertUser = (notice) => globalThis.${key}.alerts.push(notice);
        export const dismissAlert = () => {};`,
      '../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
      './analysis.ts': `export const useAnalysisStore = () => globalThis.${key}.analysis;`,
      './notify-watch.js': `export const useNotifyWatchStore = () => globalThis.${key}.pipeline;`,
      './board.js': `export const useBoardStore = () => globalThis.${key}.board;`,
      './plugins.js': `export const usePluginsStore = () => globalThis.${key}.plugins;`,
    },
  });

  setActivePinia(pinia);

  const store = module.useTaskShelfStore();

  t.after(() => {
    store.stop();
    disposePinia(pinia);
    setActivePinia(undefined);
    delete globalThis[key];
  });

  return {
    h,
    store,
    state,
  };
}

test('TWS-01: полка карточки не ходит в портал и не оповещает', async (t) => {
  const channels = installChannels(t);

  const { h, store } = await shelfFixture(t);

  store.setPassive(true);
  assert.equal(await store.load(true, { silent: true }), true);
  assert.equal(store.loaded, true);
  assert.deepEqual(store.entries.map((item) => item.taskId), ['11', '99']);
  h.board.data.tasks[0].unread = 1;
  assert.equal(await store.toggle('12'), true);
  assert.equal(store.isOnShelf('12'), true);
  assert.equal(await store.acknowledge('11'), true);
  assert.equal(await store.remove('12'), true);
  assert.equal(store.isOnShelf('12'), false);
  assert.equal(await store.load(true, { silent: true }), true);
  assert.equal(store.isOnShelf('11'), true);
  assert.equal(store.isOnShelf('99'), true);
  store.clear();
  assert.equal(await store.load(true, { silent: true }), true);
  assert.equal(store.isOnShelf('11'), true);
  assert.deepEqual(store.pending, {});
  assert.deepEqual(h.calls.filter((call) => /^\/api\/tracker\/task\//.test(call.url)), []);
  assert.deepEqual(h.alerts, []);
  assert.equal(h.calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/11')).length, 0);
  assert.deepEqual(channels.flatMap((channel) => channel.posted), [
    {
      version: 1,
      type: 'shelf-acknowledge',
      taskId: '11',
      source: 'tracker',
    },
  ]);
});

/**
 * Канал связывает только два синтетических документа и не оставляет Node handles.
 * Доставка асинхронна, как у настоящего BroadcastChannel, без отражения отправителю.
 */
function installChannels(t) {
  const original = globalThis.BroadcastChannel;
  const channels = [];

  globalThis.BroadcastChannel = class {
    onmessage = null;

    constructor(name) {
      this.name = name;
      this.posted = [];
      channels.push(this);
    }

    /**
     * Сообщение доставляется только соседям того же канала в следующей микрозадаче.
     * Отправитель не получает эхо, закрытые документы больше не участвуют в доставке.
     */
    postMessage(data) {
      this.posted.push(structuredClone(data));

      for (const other of channels) {
        if (other !== this && other.name === this.name && !other.closed) {
          queueMicrotask(() => other.onmessage?.({ data: structuredClone(data) }));
        }
      }
    }

    close() {
      this.closed = true;
      this.onmessage = null;
    }
  };
  t.after(() => {
    channels.forEach((channel) => channel.close());
    globalThis.BroadcastChannel = original;
  });

  return channels;
}

test('TWS-02: открытие в карточке гасит огонь конвейера в главном окне', async (t) => {
  installChannels(t);

  const main = await shelfFixture(t, ['42']);
  const surface = await shelfFixture(t, ['42']);

  main.h.board.data.tasks[0].id = 42;
  main.h.pipeline.loadedAt = 1;
  main.h.pipeline.observedByTask['42'] = {
    attempt: 'a1',
    gateKnown: true,
    gate: 'GATE_PLAN',
  };
  surface.store.setPassive(true);
  await main.store.load(true, { silent: true });
  await surface.store.load(true, { silent: true });

  const { startShelfRelay } = await compileModule(webFile('src/shared/windowRelay.ts'));
  const channel = new BroadcastChannel('grigdesk-task-data-v1');
  const stop = startShelfRelay({
    role: 'source',
    channel,
    acknowledge: (id) => main.store.acknowledge(id),
  });

  t.after(stop);
  assert.equal(await surface.store.acknowledge('42'), true);
  await new Promise((resolve) => setImmediate(resolve));

  const puts = main.h.calls.filter((call) => call.method === 'PUT');

  assert.equal(surface.h.calls.filter((call) => call.method === 'PUT').length, 0);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.snapshot.pipeline.gate, 'GATE_PLAN');
  assert.equal(puts[0].body.createIfMissing, false);
  assert.equal(main.store.rows.find((row) => row.taskId === '42').state, 'neutral');

  for (const data of [
    {
      version: 1,
      type: 'shelf-acknowledge',
      taskId: '42',
      extra: true,
    },
    {
      version: 1,
      type: 'shelf-acknowledge',
      taskId: '042',
    },
    {
      version: 2,
      type: 'shelf-acknowledge',
      taskId: '42',
    },
  ]) {
    channel.onmessage({ data });
  }

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(main.h.calls.filter((call) => call.method === 'PUT').length, 1);
});
