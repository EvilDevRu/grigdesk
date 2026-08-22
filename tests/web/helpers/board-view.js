// Общая обвязка для офлайн-тестов доски (`views/BoardView.vue`).
//
// Вью компилируется в память и грузится как `data:`-модуль, а такой модуль НЕ УМЕЕТ
// резолвить относительные импорты: любой `import ... from '../…'` внутри вью падает
// `ERR_UNSUPPORTED_RESOLVE_REQUEST` и роняет все тесты файла разом. Поэтому каждый
// импорт заменяется заглушкой прямо в исходнике — и делать это нужно в ОДНОМ месте:
// пока замены жили копией в одном тесте, добавленный во вью импорт (`task-seen`)
// ломал его молча и целиком.
//
// Второй известный подвох — кэш модулей: Node ключует `data:`-URL целиком, а две
// компиляции одного SFC дают побайтово равный текст (scopeId в вывод не попадает).
// Без хвоста-nonce второй mount получил бы модуль первого вместе с его сторами.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VIEW_PATH = fileURLToPath(new URL('../../../web/src/views/BoardView.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;
// Отбор списка — настоящий: тесты доски проверяют в том числе сочетание фильтров.
const LIST_URL = pathToFileURL(fileURLToPath(
  new URL('../../../web/src/shared/board-task-list.js', import.meta.url),
)).href;
const HAPPY_DOM = '../../../web/node_modules/happy-dom/lib/index.js';
const TEST_UTILS = '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs';
const COMPILER_SFC = '../../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js';

let compileNonce = 0;

/** Компиляция вью с заглушками вместо импортов. */
export async function compileBoardView(prefix = 'board') {
  const { parse, compileScript } = await import(COMPILER_SFC);
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  const code = compileScript(descriptor, {
    id: `data-v-${prefix}-${compileNonce}`,
    inlineTemplate: true,
  }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replaceAll("from 'pinia'", `from "${PINIA_URL}"`)
    .replace(
      "import { hoursToHM, liveTimerSec, secToHMS, signed } from '../shared/format.js';",
      'const hoursToHM = (n) => String(n ?? 0); const liveTimerSec = (t) => t.timerElapsed || 0;'
      + ' const secToHMS = (n) => String(n ?? 0); const signed = (n) => String(n ?? 0);',
    )
    .replace(
      "import { useBoardStore } from '../stores/board.js';",
      'const useBoardStore = globalThis.__boardViewStores.board;',
    )
    .replace(
      "import { useUiStore } from '../stores/ui.js';",
      'const useUiStore = globalThis.__boardViewStores.ui;',
    )
    .replace(
      "import { useAnalysisStore } from '../stores/analysis.js';",
      'const useAnalysisStore = globalThis.__boardViewStores.analysis;',
    )
    .replace(
      "import { useTaskFavoritesStore } from '../stores/task-favorites.js';",
      'const useTaskFavoritesStore = globalThis.__boardViewStores.favorites;',
    )
    .replace(
      "import { useTaskSeenStore } from '../stores/task-seen.js';",
      'const useTaskSeenStore = globalThis.__boardViewStores.seen;',
    )
    .replace(
      "import MiniChart from './board/MiniChart.vue';",
      'const MiniChart = { template: "<div></div>" };',
    )
    .replace(
      "import TriageBadge from './board/TriageBadge.vue';",
      'const TriageBadge = { template: "<span></span>" };',
    )
    .replace(
      "import TaskFavoriteButton from './board/TaskFavoriteButton.vue';",
      `const TaskFavoriteButton = {
        props: ["active", "pending", "taskTitle"],
        emits: ["toggle"],
        template: '<button class="stub-fav" :aria-pressed="String(active)" @click="$emit(\\'toggle\\')">{{ taskTitle }}</button>',
      };`,
    )
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = { get: async () => ({ tasks: [] }) };',
    )
    .replace(
      "import { useSse } from '../composables/useSse.js';",
      'const useSse = () => ({});',
    )
    .replace(
      "import { confirmDialog } from '../shared/ui/confirm.js';",
      'const confirmDialog = async () => false;',
    )
    .replace(
      "from '../shared/board-task-list.js'",
      `from "${LIST_URL}"`,
    );
  const nonce = compileNonce++;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce}`
  )).default;
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
  seen = {},
  triagePrefs,
} = {}) {
  const browser = await installBrowser(t);
  if (triagePrefs !== undefined) browser.localStorage.setItem('board.triage', triagePrefs);
  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import(TEST_UTILS),
    import(PINIA_URL),
  ]);
  const nonce = compileNonce;
  const calls = { toggled: [], favoritesLoad: [], seenLoad: [], seenMarked: [] };
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
    ui: defineStore(`board-view-ui-${nonce}`, { actions: { openTask() {} } }),
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
  const BoardView = await compileBoardView(prefix);
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
