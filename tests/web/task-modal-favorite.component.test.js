import assert from 'node:assert/strict';
import test from 'node:test';
import { compileTaskModal } from './helpers/task-modal.js';

process.env.NODE_ENV = 'test';

test('UI-05/06: TaskModal переключает тот же favorite store и показывает его ошибку', async (t) => {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/board' });
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
  const toggled = [];
  const shelfToggled = [];
  const acknowledged = [];
  const markedSeen = [];
  globalThis.__taskModalFavoriteApi = {
    async get(url) {
      if (url.endsWith('/clarifications')) return { text: '' };
      if (url === '/api/tasks') return { tasks: [] };
      return {};
    },
    async post() { return {}; },
    async upload() { return {}; },
  };
  globalThis.__taskModalFavoriteUiStore = defineStore('task-modal-favorite-ui', {
    state: () => ({ taskId: 42 }),
    actions: { close() {} },
  });
  globalThis.__taskModalFavoriteTasksStore = defineStore('task-modal-favorite-tasks', {
    actions: {
      async load() { return { title: 'Задача 42', description: '' }; },
      async timer() {},
      async complete() {},
      async comment() {},
      async launch() { return {}; },
    },
  });
  globalThis.__taskModalFavoriteBoardStore = defineStore('task-modal-favorite-board', {
    state: () => ({
      data: {
        tasks: [{ id: 42, title: 'Задача 42', group: 'Проект', timerElapsed: 0 }],
        toReview: [], created: [], accomplice: [], auditor: [],
      },
    }),
    actions: { async load() {} },
  });
  globalThis.__taskModalFavoriteAnalysisStore = defineStore('task-modal-favorite-analysis', {
    actions: { async detail() { return {}; }, async analyze() {} },
  });
  globalThis.__taskModalFavoriteFavoritesStore = defineStore('task-modal-favorite', {
    state: () => ({
      taskIds: [],
      loaded: true,
      loading: false,
      error: null,
      pending: {},
    }),
    getters: {
      isFavorite: (state) => (id) => state.taskIds.includes(String(id)),
      isPending: (state) => (id) => !!state.pending[String(id)],
    },
    actions: {
      async load() {},
      async toggle(id) {
        toggled.push(String(id));
        this.error = 'Не удалось сохранить звезду';
        return false;
      },
    },
  });
  globalThis.__taskModalFavoriteShelfStore = defineStore('task-modal-shelf', {
    state: () => ({
      entries: [],
      loaded: false,
      loading: false,
      error: null,
      pending: {},
    }),
    getters: {
      isOnShelf: (state) => (id) => state.entries
        .some((entry) => entry.taskId === String(id)),
      isPending: (state) => (id) => !!state.pending[String(id)],
    },
    actions: {
      async toggle(id) { shelfToggled.push(String(id)); return true; },
      async acknowledge(id) { acknowledged.push(String(id)); return true; },
    },
  });
  globalThis.__taskModalFavoritePluginsStore = defineStore('task-modal-plugins', {
    state: () => ({
      loaded: true,
      list: [{ id: 'shelf', enabled: true, values: {} }],
    }),
    getters: {
      enabled: (state) => (id) => !!state.list.find((item) => item.id === id)?.enabled,
      byId: (state) => (id) => state.list.find((item) => item.id === id) || null,
    },
  });

  // Отметка просмотра: открытая задача перестаёт быть новой. Отказ отметки не имеет
  // права мешать показу задачи, поэтому действие возвращает false и ничего не бросает.
  globalThis.__taskModalFavoriteSeenStore = defineStore('task-modal-favorite-seen', {
    state: () => ({ taskIds: [], loaded: true, initialized: true, loading: false, error: null }),
    getters: {
      isSeen: (state) => (id) => state.taskIds.includes(String(id)),
      ready: (state) => state.loaded && state.initialized,
    },
    actions: {
      async load() {},
      async markSeen(ids) { markedSeen.push(ids.map(String)); return false; },
    },
  });

  const pinia = createPinia();
  const TaskModal = await compileTaskModal('__taskModalFavorite');
  const wrapper = mount(TaskModal, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__taskModalFavoriteApi',
      '__taskModalFavoriteUiStore',
      '__taskModalFavoriteTasksStore',
      '__taskModalFavoriteBoardStore',
      '__taskModalFavoriteAnalysisStore',
      '__taskModalFavoriteFavoritesStore',
      '__taskModalFavoriteShelfStore',
      '__taskModalFavoritePluginsStore',
      '__taskModalFavoriteSeenStore',
    ]) delete globalThis[key];
  });
  await flushPromises();

  // Метка «новая» снимается именно открытием задачи — это единственное место,
  // где кокпит узнаёт, что человек её прочитал.
  assert.deepEqual(markedSeen, [['42']]);
  assert.deepEqual(acknowledged, []);
  const shelfStore = globalThis.__taskModalFavoriteShelfStore(pinia);
  shelfStore.entries = [{ taskId: '42' }];
  shelfStore.loaded = true;
  await flushPromises();
  assert.deepEqual(acknowledged, ['42']);

  const button = wrapper.get('button.stub-modal-fav');
  assert.equal(button.attributes('aria-pressed'), 'false');
  assert.match(button.text(), /Задача 42/);
  await button.trigger('click');
  await flushPromises();

  assert.deepEqual(toggled, ['42']);
  assert.match(wrapper.text(), /Не удалось сохранить звезду/);

  const shelfButton = wrapper.get('[data-role="task-shelf-toggle"]');
  assert.ok(shelfButton, 'в карточке должна быть кнопка полки');
  assert.equal(shelfButton.attributes('aria-pressed'), 'true');
  await shelfButton.trigger('click');
  await flushPromises();

  assert.deepEqual({
    shelfToggled,
    favoriteToggled: toggled,
    stillFavorite: wrapper.get('button.stub-modal-fav').attributes('aria-pressed'),
  }, {
    shelfToggled: ['42'],
    favoriteToggled: ['42'],
    stillFavorite: 'false',
  });
});
