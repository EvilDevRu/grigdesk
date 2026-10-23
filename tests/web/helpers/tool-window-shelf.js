import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './compile-vue.js';

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
export async function shelfFixture(t, ids = ['11', '99']) {
  const { createPinia, disposePinia, setActivePinia } = await import(
    '../../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const { reactive } = await import('../../../web/node_modules/vue/index.mjs');
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

      return url === '/api/b24/task-shelf'
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

      if(old) {
        old.snapshot = structuredClone(body.snapshot);
      } else if(body.createIfMissing) {
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

      '../composables/useSse.ts':

        'export const sseSubscribe = () => () => {};',

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

/**
 * Связывает два документа асинхронной доставкой JSON без сетевых handles.
 * Закрытый канал больше не получает сообщения и не мешает завершению теста.
 */
export function installChannels(t) {
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

      for(const other of channels) {
        if(other !== this && other.name === this.name && !other.closed) {
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

