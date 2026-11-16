import { trackerMetadata } from './helpers/trackerCard.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileTaskModal } from './helpers/task-modal.js';

process.env.NODE_ENV = 'test';

// Тумблер автостарта: выключенная настройка просит сервер создать конвейер без
// запуска узлов (autoStart:false в payload), а ACK created показывает «Создан,
// ожидает старта». Включённая и отсутствующая настройка сохраняют прежний запуск.
async function mountLaunchForm(t, { prefs = {}, launch = null } = {}) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/board' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    FormData: browser.FormData,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const launchCalls = [];
  const listeners = new Set();

  globalThis.__taskModalLaunchSubscribe = (handler) => {
    listeners.add(handler);

    return () => listeners.delete(handler);
  };
  globalThis.__taskModalLaunchApi = {
    async get(url) {
      if (url === '/api/trackers') {
        return trackerMetadata();
      }

      if (url === '/api/settings/prefs') return prefs;
      if (url.endsWith('/clarifications')) return { text: '' };
      if (url === '/api/tasks') return { tasks: [] };
      return {};
    },
    async post() { return {}; },
    async upload() { return {}; },
  };
  globalThis.__taskModalLaunchRunnerDisplay = await import('../../web/src/shared/runnerDisplay.ts');
  globalThis.__taskModalLaunchUiStore = defineStore('task-modal-launch-ui', {
    state: () => ({ taskId: 42 }),
    actions: { close() {} },
  });
  globalThis.__taskModalLaunchTasksStore = defineStore('task-modal-launch-tasks', {
    actions: {
      async load() { return { title: 'Обновить отчёт', description: 'Проверить результат' }; },
      async timer() {},
      async complete() {},
      async comment() {},
      async launchOptions() {
        return {
          profiles: ['project-alpha'],
          profile: 'project-alpha',
          routes: ['feature'],
          defaultRoute: 'feature',
          routeOptions: { feature: { deliveryMode: 'publish', instrumentationRequired: false } },
          repositories: [{ name: 'repo', targetBranch: 'main' }],
        };
      },
      async launch(id, payload) {
        launchCalls.push([String(id), payload]);

        if (launch) {
          return launch(id, payload);
        }

        return { outcome: 'launched', profile: payload.profile, route: payload.route };
      },
    },
  });
  globalThis.__taskModalLaunchBoardStore = defineStore('task-modal-launch-board', {
    state: () => ({
      data: {
        tasks: [{ id: 42, title: 'Обновить отчёт', group: 'Проект Бета' }],
        toReview: [], created: [], accomplice: [], auditor: [],
      },
    }),
    actions: { async load() {} },
  });
  globalThis.__taskModalLaunchAnalysisStore = defineStore('task-modal-launch-analysis', {
    actions: {
      async detail() { return {}; },
      async analyze() {},
    },
  });
  globalThis.__taskModalLaunchFavoritesStore = defineStore('task-modal-launch-favorite', {
    state: () => ({ taskIds: [], loaded: true, loading: false, error: null, pending: {} }),
    getters: {
      isFavorite: () => () => false,
      isPending: () => () => false,
    },
    actions: { async load() {}, async toggle() {} },
  });
  globalThis.__taskModalLaunchSeenStore = defineStore('task-modal-launch-seen', {
    state: () => ({ taskIds: [], loaded: true, initialized: true, loading: false, error: null }),
    getters: {
      isSeen: () => () => false,
      ready: () => true,
    },
    actions: { async load() {}, async markSeen() { return true; } },
  });

  const wrapper = mount(await compileTaskModal('__taskModalLaunch'), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__taskModalLaunchApi',
      '__taskModalLaunchRunnerDisplay',
      '__taskModalLaunchUiStore',
      '__taskModalLaunchTasksStore',
      '__taskModalLaunchBoardStore',
      '__taskModalLaunchAnalysisStore',
      '__taskModalLaunchFavoritesStore',
      '__taskModalLaunchSeenStore',
      '__taskModalLaunchSubscribe',
    ]) delete globalThis[key];
  });
  await flushPromises();

  return { wrapper, flushPromises, launchCalls };
}

async function submitLaunch({ wrapper, flushPromises }) {
  await wrapper.get('[data-role="task-launch-open"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-role="task-launch-note"]').setValue('Критерий человека');
  await wrapper.get('[data-role="task-launch-submit"]').trigger('click');
  await flushPromises();
}

test('выключенный автостарт шлёт autoStart:false и показывает «Создан, ожидает старта»', async (t) => {
  const harness = await mountLaunchForm(t, {
    prefs: { pipelineAutoStart: false },
    launch: async (id, payload) => ({
      outcome: 'created', profile: payload.profile, route: payload.route, attempt: 'a_0123456789abcdef0123456789abcdef',
    }),
  });

  await submitLaunch(harness);
  assert.equal(harness.launchCalls.length, 1);
  assert.equal(harness.launchCalls[0][1].autoStart, false);
  assert.match(harness.wrapper.text(), /Создан, ожидает старта/u);
});

test('включённый автостарт не добавляет поле: запуск остаётся прежним', async (t) => {
  const harness = await mountLaunchForm(t, { prefs: { pipelineAutoStart: true } });

  await submitLaunch(harness);
  assert.equal(harness.launchCalls.length, 1);
  assert.equal('autoStart' in harness.launchCalls[0][1], false);
});

test('отсутствующая настройка не меняет прежнего запуска', async (t) => {
  const harness = await mountLaunchForm(t, { prefs: {} });

  await submitLaunch(harness);
  assert.equal(harness.launchCalls.length, 1);
  assert.equal('autoStart' in harness.launchCalls[0][1], false);
});
