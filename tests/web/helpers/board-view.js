// Общая обвязка для офлайн-тестов доски (`views/BoardView.vue`).
//
// Общий compiler бандлит относительные Vue/TypeScript-импорты, а доменные stores и
// network-зависимости подменяются здесь один раз. UI facade остаётся настоящим, чтобы
// тесты видели те же primitive/composite contracts, что и production-доска.
import { compileVue, singletonUrl, webFile } from './compile-vue.js';

const VIEW_PATH = webFile('src/views/BoardView.vue');
const PINIA_URL = singletonUrl('pinia');
const HAPPY_DOM = '../../../web/node_modules/happy-dom/lib/index.js';
const TEST_UTILS = '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs';

let mountNonce = 0;

/** Компиляция вью через общий TS-aware helper с настоящими UI-компонентами. */
export async function compileBoardView() {
  return compileVue(VIEW_PATH, {
    stubs: {
      '../shared/format.ts': `
        export const hoursToHM = (value) => String(value ?? 0);
        export const liveTimerSec = (task) => task.timerElapsed || 0;
        export const secToHMS = (value) => String(value ?? 0);
        export const signed = (value) => String(value ?? 0);
      `,
      '../stores/board.js': `
        export const useBoardStore = (...args) => globalThis.__boardViewStores.board(...args);
      `,
      '../stores/ui.js': `
        export const useUiStore = (...args) => globalThis.__boardViewStores.ui(...args);
      `,
      '../actions/analysis': `
        export const useAnalysisStore = (...args) => globalThis.__boardViewStores.analysis(...args);
        export const analyzeTask = (...args) =>
          globalThis.__boardViewStores.analysis().analyze(...args);
        export const startAnalysisPolling = () =>
          globalThis.__boardViewStores.analysis().startPolling?.();
      `,
      '../stores/task-favorites.js': `
        export const useTaskFavoritesStore = (...args) =>
          globalThis.__boardViewStores.favorites(...args);
      `,
      '../stores/taskShelf.ts': `
        export const useTaskShelfStore = (...args) =>
          globalThis.__boardViewStores.shelf(...args);
      `,
      '../stores/plugins.js': `
        export const usePluginsStore = (...args) =>
          globalThis.__boardViewStores.plugins(...args);
      `,
      '../stores/task-seen.js': `
        export const useTaskSeenStore = (...args) => globalThis.__boardViewStores.seen(...args);
      `,
      './board/MiniChart.vue': `
        export default { template: '<div></div>' };
      `,
      './board/TriageBadge.vue': `
        export default { template: '<span></span>' };
      `,
      './board/TaskFavoriteButton.vue': `
        export default {
          props: ['active', 'pending', 'taskTitle'],
          emits: ['toggle'],
          template: '<button class="stub-fav" :aria-pressed="String(active)"'
            + ' @click="$emit(\\'toggle\\')">{{ taskTitle }}</button>',
        };
      `,
      '../shared/apiClient.ts': `
        export const api = { get: async () => ({ tasks: [] }) };
      `,
      '../composables/useSse.ts': `
        export const useSse = () => ({});
      `,
    },
  });
}

/** Браузерное окружение happy-dom с классами DOM в глобалях. */
export async function installBrowser(t) {
  const { Window } = await import(HAPPY_DOM);
  const browser = new Window({ url: 'http://cockpit.test/#/board' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    XMLSerializer: browser.XMLSerializer,
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
  t.after(() => browser.close());
  return browser;
}

const DEFAULT_TASKS = [
  { id: 11, title: 'Первая задача', group: 'A', timerElapsed: 0 },
  { id: 22, title: 'Вторая задача', group: 'B', timerElapsed: 0 },
];

/**
 * Смонтированная доска.
 *
 * `favorites`/`seen` — начальное состояние одноимённых сторов; всё, что тест не задал,
 * берётся из умолчаний «загружено, ошибок нет». `calls` копит обращения к действиям:
 * по ним проверяется, что вью зовёт стор, а не крутит свою копию состояния.
 *
 * @returns {{browser, wrapper, flushPromises, calls, stores}}
 */
export async function mountBoardView(t, {
  prefix = 'board',
  tasks = DEFAULT_TASKS,
  toReview = [],
  created = [],
  analysis = {},
  favorites = {},
  shelf = {},
  shelfEnabled = true,
  analysisEnabled = true,
  seen = {},
  triagePrefs,
} = {}) {
  const browser = await installBrowser(t);
  if (triagePrefs !== undefined) browser.localStorage.setItem('board.triage', triagePrefs);
  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import(TEST_UTILS),
    import(PINIA_URL),
  ]);
  const nonce = `${prefix}-${mountNonce++}`;
  const calls = {
    opened: [],
    toggled: [],
    favoritesLoad: [],
    shelfLoad: [],
    seenLoad: [],
    seenMarked: [],
  };
  const stores = {
    board: defineStore(`board-view-board-${nonce}`, {
      state: () => ({
        data: {
          userId: 7,
          today: { hours: 0, tasks_count: 0, avg_time: 0 },
          dynamics: {},
          month: { hours: 0, norm: 1 },
          charts: {},
          tasks,
          toReview,
          created,
        },
        error: null,
        loading: false,
      }),
      actions: { async load() {} },
    }),
    ui: defineStore(`board-view-ui-${nonce}`, {
      actions: { openTask(id) { calls.opened.push(String(id)); } },
    }),
    analysis: defineStore(`board-view-analysis-${nonce}`, {
      state: () => ({ byTask: analysis }),
      actions: { startPolling() {}, async analyze() {} },
    }),
    favorites: defineStore(`board-view-favorites-${nonce}`, {
      state: () => ({
        taskIds: [], loaded: true, loading: false, error: null, pending: {}, ...favorites,
      }),
      getters: {
        isFavorite: (state) => (id) => state.taskIds.includes(String(id)),
        isPending: (state) => (id) => !!state.pending[String(id)],
      },
      actions: {
        async load(force) { calls.favoritesLoad.push(!!force); },
        async toggle(id) { calls.toggled.push(String(id)); return true; },
      },
    }),
    shelf: defineStore(`board-view-shelf-${nonce}`, {
      state: () => ({
        entries: [], loaded: true, loading: false, error: null, pending: {}, ...shelf,
      }),
      getters: {
        isOnShelf: (state) => (id) => state.entries
          .some((entry) => entry.taskId === String(id)),
        isPending: (state) => (id) => !!state.pending[String(id)],
      },
      actions: {
        async load(force) { calls.shelfLoad.push(!!force); },
      },
    }),
    plugins: defineStore(`board-view-plugins-${nonce}`, {
      state: () => ({
        loaded: true,
        list: [
          { id: 'shelf', enabled: shelfEnabled, values: {} },
          { id: 'analysis', enabled: analysisEnabled, values: {} },
        ],
      }),
      getters: {
        enabled: (state) => (id) => !!state.list.find((item) => item.id === id)?.enabled,
        byId: (state) => (id) => state.list.find((item) => item.id === id) || null,
      },
    }),
    // Отметки просмотра: `initialized` — базовая линия. Без неё новых задач не бывает
    // вовсе (иначе после первого запуска новыми выглядели бы все давние задачи).
    seen: defineStore(`board-view-seen-${nonce}`, {
      state: () => ({
        taskIds: [], loaded: true, initialized: true, loading: false, error: null, ...seen,
      }),
      getters: {
        isSeen: (state) => (id) => state.taskIds.includes(String(id)),
        ready: (state) => state.loaded && state.initialized,
      },
      actions: {
        async load(force) { calls.seenLoad.push(!!force); },
        async markSeen(ids, opts) { calls.seenMarked.push({ ids: ids.map(String), opts }); return true; },
      },
    }),
  };
  globalThis.__boardViewStores = stores;
  const pinia = createPinia();
  const BoardView = await compileBoardView();
  const wrapper = mount(BoardView, {
    attachTo: browser.document.querySelector('#mount'),
    global: {
      plugins: [pinia],
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__boardViewStores;
  });
  await flushPromises();
  return { browser, wrapper, flushPromises, calls, stores };
}
