
import { compileTaskModal } from './task-modal.js';
import { installUiBrowser } from './ui-components.js';
import { trackerMetadata } from './trackerCard.js';

export const LOCAL_TASK = {
  id: '100000000001',
  source: 'grigdesk',
  title: 'Своя задача',
  description: '<текст>& без HTML',
  projectId: 'beta',
  projectTitle: 'Проект Бета',
  sourceUrl: 'http://client.test/#/board?openTask=100000000001',
  createdAt: '2026-10-24T00:00:00.000Z',
};

process.env.NODE_ENV = 'test';

let nonce = 0;

function triageDetail() {
  return {
    analysis: {
      complexity: 3,
      risk: 2,
      diff_size: 'M',
      route_guess: 'feature',
      confidence: 'low',
      questions: [
        {
          id: 'q-mode',
          text: 'Какой режим оставить?',
          options: [
            {
              id: 'o-auto',
              label: 'Автоматический',
              description: 'Система выбирает режим сама.',
            },
            {
              id: 'o-manual',
              label: 'Ручной',
              description: 'Человек подтверждает режим перед запуском.',
            },
          ],
          recommendation: { option: 'o-manual', reason: 'Безопаснее для старых задач' },
        },
        {
          id: 'q-label',
          text: 'Как подписать кнопку?',
          options: [],
          recommendation: null,
        },
      ],
      meta: {
        provider: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        duration_ms: 60_000,
      },
    },
    note: '',
    stale: [],
    status: { state: 'done' },
  };
}

// Сохранённый ответ приходит с копией вопроса: карточка ищет его и по идентификатору,
// и по смыслу текста, потому что следующий заход триажа переписывает вопросы заново.
function triageClarifications() {
  return {
    text: '## Разбор арбитра — машинный — Как подписать кнопку?\nПоле уже есть в форме.',
    entries: [{
      id: 'answer-1',
      questionId: 'q-label',
      questionText: 'Как подписать кнопку?',
      actor: 'grigdesk-arbiter',
      status: 'answered',
      selection: [],
      selectionLabels: [],
      text: 'Поле уже есть в форме.',
      attachments: [],
      proof: [],
    }],
  };
}

/**
 * Настоящая карточка получает собственную запись и управляемые ответы оценки.
 * Счётчики личных служб выявляют эффекты, которые нельзя скрыть только шаблоном.
 */
export async function mountLocalCard(t, {
  task = LOCAL_TASK,
  load = null,
  presentation = 'dialog',
  wrap = null,
  launchOptions = null,
  enabled = true,
  detail = triageDetail(),
  clarifications = triageClarifications(),
} = {}) {
  nonce += 1;

  const prefix = `__taskModalAnalysis${nonce}`;
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/board');

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const personal = [];
  const reads = [];
  const listeners = new Set();
  const posts = [];
  const analyzed = [];

  globalThis[`${prefix}Api`] = {
    /**
     * Оценка читает локальные уточнения, а список конвейера изолирован от портала.
     * Счётчик фиксирует любой случайный запрос Б24 для собственной карточки.
     */
    async get(url) {
      reads.push(url);

      if (url === '/api/trackers') {
        return trackerMetadata();
      }

      if (url.endsWith('/clarifications')) {
        return clarifications;
      }
      if (url === '/api/tasks') {
        return { tasks: [] };
      }

      return {};
    },
    async post(url, body) {
      posts.push({ url, body: structuredClone(body) });

      return { text: 'сохранено', entries: [] };
    },
    async upload() {
      return {};
    },
  };
  globalThis[`${prefix}UiStore`] = defineStore(`${prefix}-ui`, {
    state: () => ({ taskId: task.id, launchRequested: false }),
    actions: { close() {}, consumeTaskLaunch() {} },
  });
  globalThis[`${prefix}TasksStore`] = defineStore(`${prefix}-tasks`, {
    actions: {
      async load(id, force) {
        return load ? load(id, force) : { ...task };
      },
      async launchOptions(id, profile) {
        return launchOptions ? launchOptions(id, profile) : {};
      },
      async timer() {},
      async complete() {},
      async comment() {},
      async launch() {
        return {};
      },
    },
  });
  globalThis[`${prefix}BoardStore`] = defineStore(`${prefix}-board`, {
    state: () => ({
      data: {
        tasks: [],
        toReview: [],
        created: [],
        accomplice: [],
        auditor: []
      },
    }),
    actions: { async load() {
      personal.push('board');
    } },
  });
  globalThis[`${prefix}AnalysisStore`] = defineStore(`${prefix}-analysis`, {
    actions: {
      async detail() {
        return structuredClone(detail);
      },
      async analyze(id) {
        analyzed.push(String(id));
      },
    },
  });
  globalThis[`${prefix}FavoritesStore`] = defineStore(`${prefix}-favorites`, {
    state: () => ({ loaded: true, error: 'Чужая ошибка избранного' }),
    getters: {
      own: () => ({
        loaded: true,
        loading: false,
        error: null,
        isFavorite: () => false,
        isPending: () => false,
        async load() {
          personal.push('own-favorites');
        },
        async toggle() {},
      }),
      isFavorite: () => () => false,
      isPending: () => () => false,
    },
    actions: { async load() {
      personal.push('favorites');
    }, async toggle() {} },
  });
  globalThis[`${prefix}SeenStore`] = defineStore(`${prefix}-seen`, {
    state: () => ({
      loaded: true,
      initialized: true,
      error: null
    }),
    getters: {
      own: () => ({
        loaded: true,
        ready: true,
        error: null,
        async markSeen() {
          personal.push('own-seen');
        },
      }),
      ready: () => true,
      isSeen: () => () => true,
    },
    actions: { async markSeen() {
      personal.push('seen');
    } },
  });
  globalThis[`${prefix}PluginsStore`] = defineStore(`${prefix}-plugins`, {
    state: () => ({
      loaded: true,
      list: [
        {
          id: 'analysis',
          enabled,
          values: { autoArbitrate: false }
        },
        {
          id: 'shelf',
          enabled: true,
          values: {}
        },
      ],
    }),
    getters: {
      enabled: (state) => (id) => state.list.find((item) => item.id === id)?.enabled ?? false,
      byId: (state) => (id) => state.list.find((item) => item.id === id) || null,
    },
  });
  globalThis[`${prefix}ShelfStore`] = defineStore(`${prefix}-shelf`, {
    state: () => ({
      loaded: true,
      entries: [],
      error: 'Чужая ошибка полки'
    }),
    getters: {
      own: () => ({
        loaded: true,
        loading: false,
        entries: [{ taskId: task.id }],
        error: null,
        isOnShelf: () => true,
        isPending: () => false,
        async load() {
          personal.push('own-shelf');
        },
        async acknowledge() {
          personal.push('own-acknowledge');

          return true;
        },
        async toggle() {},
      }),
      isOnShelf: () => () => false,
      isPending: () => () => false,
    },
    actions: {
      async load() {
        personal.push('shelf');
      },
      async acknowledge() {
        personal.push('acknowledge');
      },
    },
  });
  globalThis[`${prefix}Subscribe`] = (listener) => {
    listeners.add(listener);

    return () => listeners.delete(listener);
  };

  const TaskModal = await compileTaskModal(prefix);
  const pinia = createPinia();
  const component = wrap ? await wrap(TaskModal, { browser, pinia }) : TaskModal;
  const wrapper = mount(component, {
    props: { presentation },
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia], stubs: { teleport: true } },
  });

  t.after(() => {
    wrapper.unmount();

    for (const suffix of [
      'Api',
      'ShelfStore',
      'Subscribe',
      'UiStore',
      'TasksStore',
      'BoardStore',
      'AnalysisStore',
      'FavoritesStore',
      'SeenStore',
      'PluginsStore',
    ]) {
      delete globalThis[`${prefix}${suffix}`];
    }
  });
  await flushPromises();
  await flushPromises();

  return {
    wrapper,
    flushPromises,
    personal,
    reads,
    listeners,
    ui: globalThis[`${prefix}UiStore`](),
    posts,
    analyzed,

  };
}

