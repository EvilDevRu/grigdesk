import { compileModule, migrationHarness, webFile } from './compile-vue.js';
import { compileTaskModal } from './task-modal.js';
import { installUiBrowser } from './ui-components.js';

export const CUSTOM_CAPS = Object.fromEntries([
  'create', 'timer', 'comments', 'attachments', 'widgets', 'editing',
  'complete', 'renew', 'users', 'projects',
].map((key) => [key, true]));
export const STOCK_CAPS = Object.fromEntries(Object.keys(CUSTOM_CAPS)
  .map((key) => [key, ['create', 'complete', 'users', 'projects'].includes(key)]));

let nonce = 0;

/**
 * Каталог явно подтверждает возможности выбранного внешнего драйвера.
 * Legacy-карточки используют тот же metadata DTO, что и проверки новых ограничений.
 */
export function trackerMetadata(trackerId = 'grigdesk-b24-discript', capabilities = CUSTOM_CAPS) {
  return {
    revision: 1,
    externalId: trackerId,
    activeIds: ['own', trackerId],
    drivers: [{
      id: trackerId,
      status: 'active',
      capabilities: { ...capabilities },
    }],
  };
}

/**
 * Настоящие TaskModal и tasks store получают только управляемые HTTP-ответы.
 * Metadata приходит независимо от details, чтобы тест различал readiness и capabilities.
 */
export async function mountTrackerCard(t, {
  trackerId = 'grigdesk-b24-discript',
  capabilities = CUSTOM_CAPS,
  id = '42',
  presentation = 'dialog',
  detailMode = 'ready',
  metadataMode = 'ready',
  status = 3,
} = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/board');
  const prefix = `__trackerCard${nonce += 1}`;
  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const calls = [];
  const listeners = new Set();
  const heldDetail = Promise.withResolvers();
  const heldMetadata = Promise.withResolvers();
  const task = {
    id: Number(id),
    trackerId,
    source: 'b24',
    title: 'Задача трекера',
    description: 'Описание',
    status,
    attachments: [{ name: 'stale.png' }],
    comments: [{ mid: 1, text: 'Устаревший комментарий' }],
  };
  const metadata = trackerMetadata(trackerId, capabilities);
  const useBoardStore = defineStore(`${prefix}-board`, {
    state: () => ({
      data: {
        trackerId,
        capabilities: metadataMode === 'empty' ? null : capabilities,
        widgets: [],
        revision: 1,
        tasks: [{
          id: Number(id),
          title: task.title,
          timerRunning: true,
          timerElapsed: 12
        }],
        toReview: [],
        created: [],
      },
    }),
    actions: { async load() {} },
  });
  const useUiStore = defineStore(`${prefix}-ui`, {
    state: () => ({ taskId: id, launchRequested: false }),
    actions: {
      close() {
        this.taskId = null;
      },
      consumeTaskLaunch() {},
    },
  });
  const api = {
    /**
     * Ответы details и metadata удерживаются раздельно.
     * Это позволяет проверить действие до details и запрет при неизвестной metadata.
     */
    async get(url) {
      calls.push({ method: 'GET', url });

      if (url === '/api/trackers' || url === '/api/trackers/settings') {
        if (metadataMode === 'held') {
          return heldMetadata.promise;
        }

        if (metadataMode === 'error' || metadataMode === 'legacy') {
          throw new migrationHarness.ApiError('Нет metadata', metadataMode === 'legacy' ? 404 : 503, {});
        }

        return metadataMode === 'empty'
          ? {
            revision: 1,
            externalId: null,
            activeIds: ['own'],
            drivers: []
          }
          : structuredClone(metadata);
      }

      if (url === `/api/tracker/task/${id}` || url === `/api/grigdesk-tasks/${id}`) {
        if (detailMode === 'held') {
          return heldDetail.promise;
        }

        if (detailMode === 'error') {
          throw new Error('Детали временно недоступны');
        }

        return structuredClone(task);
      }

      if (url === '/api/tasks') {
        return { tasks: [] };
      }

      if (url.endsWith('/comments')) {
        return { comments: [{ mid: 1, text: 'Устаревший комментарий' }] };
      }

      return {};
    },
    async post(url, payload, options) {
      calls.push({
        method: 'POST',
        url,
        payload,
        options
      });

      return { ok: true };
    },
    async put(url, payload) {
      calls.push({
        method: 'PUT',
        url,
        payload
      });

      return structuredClone(task);
    },
  };
  const globals = {
    Api: api,
    ApiError: migrationHarness.ApiError,
    UiStore: useUiStore,
    BoardStore: useBoardStore,
    AnalysisStore: () => ({ detail: async () => ({}) }),
    FavoritesStore: () => ({
      loaded: true,
      isFavorite: () => false,
      isPending: () => false,
      load: async () => {},
    }),
    SeenStore: () => ({ markSeen: async () => {} }),
    Subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };

  for (const [suffix, value] of Object.entries(globals)) {
    globalThis[`${prefix}${suffix}`] = value;
  }

  const tasks = await compileModule(webFile('src/stores/tasks.ts'), {
    stubs: {
      '../shared/apiClient.ts': `
        export const api = globalThis.${prefix}Api;
        export const ApiError = globalThis.${prefix}ApiError;
      `,
      './board.ts': `export const useBoardStore = globalThis.${prefix}BoardStore;`,
    },
  });

  globalThis[`${prefix}TasksStore`] = tasks.useTasksStore;

  const pinia = createPinia();
  const component = await compileTaskModal(prefix);
  const wrapper = mount(component, {
    props: { presentation },
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia], stubs: { teleport: true } },
  });

  t.after(() => {
    heldDetail.resolve(task);
    heldMetadata.resolve(metadata);
    wrapper.unmount();

    for (const suffix of [...Object.keys(globals), 'TasksStore']) {
      delete globalThis[`${prefix}${suffix}`];
    }
  });
  await flushPromises();
  await flushPromises();

  return {
    wrapper,
    calls,
    flushPromises,
    listeners,
    heldDetail,
    heldMetadata,
    metadata,
    board: useBoardStore(pinia),
    ui: useUiStore(pinia),
    tasks: tasks.useTasksStore(pinia),
  };
}

export const cardButton = (wrapper, label) => wrapper.findAll('footer.controls button')
  .find((button) => button.text().includes(label));
