import { compilePipelineView } from './pipeline-view.js';
import { installUiBrowser } from './ui-components.js';

export const stopDetails = {
  what: 'Результат этапа не записан после трёх заходов.',
  cause: 'Возможно, исполнитель упёрся в лимит времени.',
  retained: 'Если черновик записан, он передаётся следующему заходу.',
  action: 'Продолжите прогон; при повторении проверьте лимит этапа.',
};

export const exhaustedStop = {
  kind: 'human',
  stage: 'SHIP',
  node: 'ship',
  stop: 'human',
  outcome: 'exhausted',
  title: 'SHIP: раннер не получил результат — 3 захода без результата, последний — unknown',
  hint: 'Длинная исходная подсказка; она нужна модалке этапа целиком.',
  comment: 'Служебный комментарий движка не должен занимать строку карточки.',
  fails: 2,
  presentation: {
    reason: 'агент не вернул результат',
    summary: 'Продолжите прогон с черновика, если он был записан.',
    details: stopDetails,
    attempts: 3,
    lastFailure: 'причина не названа',
    model: 'example-sol',
  },
};

/**
 * Фикстура задаёт оба сетевых DTO одной остановкой, включая узел стенда без registry key.
 * Все данные синтетические; состояние фабрики и папки владельца не используются.
 */
export function stallFixture(stall = exhaustedStop, taskOverrides = {}, graphOverrides = {}) {
  const factoryTask = {
    task: 42,
    profile: 'demo',
    route: 'feature',
    workspaceMode: 'isolated',
    readOnly: false,
    daemonAlive: false,
    attempt: 'a_fixture',
    result: null,
    stall: stall ? structuredClone(stall) : null,
    ...taskOverrides,
  };
  const node = stall?.stage === 'SANDBOX' ? 'sandbox' : 'ship';
  const graph = {
    route: 'feature',
    daemonAlive: factoryTask.daemonAlive,
    readOnly: factoryTask.readOnly,
    nodes: { ship: ['agent', '🚢 Вливание в dev'], sandbox: ['infra', '🧪 Стенд'] },
    pos: { ship: [140, 55], sandbox: [400, 55] },
    edges: [['ship', 'sandbox', '', 'pass', 'h']],
    keys: { ship: 'SHIP' },
    statuses: { ship: 'stall', sandbox: 'pending' },
    nodeMeta: {},
    progress: {
      done: 0,
      total: 2,
      current: node,
    },
    stall: stall ? { ...structuredClone(stall), node } : null,
    ...graphOverrides,
  };

  return { factoryTask, graph };
}

/**
 * Настоящий граф и UI-компоненты проверяют единственную панель и действующие обработчики.
 * Подменяются только сеть, stores и подтверждения; запросы никогда не уходят на стенд.
 */
export async function mountStallPipeline(t, fixture = stallFixture(), options = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/pipeline');

  if (options.compact) {
    browser.localStorage.setItem('grigdesk-compact', '1');
  }

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const posts = [];
  const confirmations = [];
  const harness = {
    fixture,
    confirmed: true,
    pending: null,
  };
  const globals = {
    Api: {
      /**
       * Выдаёт только два DTO текущего сценария через прежние URL.
       * Остальные чтения не обращаются к реальному серверу.
       */
      async get(url) {
        if (url === '/api/tasks?sources=1') {
          return { tasks: [harness.fixture.factoryTask, ...(harness.fixture.additionalTasks || [])] };
        }

        if (url.endsWith('/graph')) {
          return harness.fixture.graph;
        }

        return {};
      },
      async post(url, body) {
        posts.push({ url, body });

        if (harness.pending) {
          await harness.pending;
        }

        return {
          ok: true,
          archived: ['pipeline'],
          branches: [],
        };
      },
    },
    ConfirmDialog: async (...args) => {
      confirmations.push(args);

      return harness.confirmed;
    },
    AlertDialog: async () => {},
    UiStore: defineStore('stop-panel-ui', { actions: { openTask() {} } }),
    TasksStore: defineStore('stop-panel-tasks', {
      actions: {
        async load() {
          return {};
        },
        title() {
          return null;
        },
      },
    }),
    BoardStore: defineStore('stop-panel-board', {
      state: () => ({ data: null }),
      actions: { async load() {} },
    }),
  };

  for (const [suffix, value] of Object.entries(globals)) {
    globalThis[`__stallPanel${suffix}`] = value;
  }

  const compiled = await compilePipelineView('__stallPanel', { realGraph: true });

  const wrapper = mount(compiled, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });

  t.after(() => {
    wrapper.unmount();

    for (const suffix of [...Object.keys(globals), 'SseHandler']) {
      delete globalThis[`__stallPanel${suffix}`];
    }
  });

  await flushPromises();

  return {
    wrapper,
    browser,
    flushPromises,
    posts,
    confirmations,
    harness,
  };
}

/**
 * Выбирает действие по видимой подписи среди кнопок карточки.
 * SVG-кнопки и другие разделы страницы не входят в набор действий.
 */
export function actionButtons(wrapper, text) {
  return wrapper.findAll('article.card button').filter((button) => button.text().includes(text));
}

/**
 * Находит публичную кнопку раскрытия по её доступной подписи.
 * Тест не зависит от локальных классов нового компонента.
 */
export function disclosure(wrapper) {
  return wrapper.findAll('button').find((button) => /подробнее/i.test(button.text()));
}
