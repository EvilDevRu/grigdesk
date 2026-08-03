import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const VIEW_PATH = fileURLToPath(new URL('../../web/src/views/BoardView.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;
const LIST_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/board-task-list.js', import.meta.url),
)).href;

async function compileBoardView() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: 'data-v-board-favorites-test',
    inlineTemplate: true,
  }).content;
  code = code
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replaceAll("from 'pinia'", `from "${PINIA_URL}"`)
    .replace(
      "import { hoursToHM, liveTimerSec, secToHMS, signed } from '../shared/format.js';",
      'const hoursToHM = (n) => String(n ?? 0); const liveTimerSec = (t) => t.timerElapsed || 0; const secToHMS = (n) => String(n ?? 0); const signed = (n) => String(n ?? 0);',
    )
    .replace(
      "import { useBoardStore } from '../stores/board.js';",
      'const useBoardStore = globalThis.__useBoardFavoritesBoardStore;',
    )
    .replace(
      "import { useUiStore } from '../stores/ui.js';",
      'const useUiStore = globalThis.__useBoardFavoritesUiStore;',
    )
    .replace(
      "import { useAnalysisStore } from '../stores/analysis.js';",
      'const useAnalysisStore = globalThis.__useBoardFavoritesAnalysisStore;',
    )
    .replace(
      "import { useTaskFavoritesStore } from '../stores/task-favorites.js';",
      'const useTaskFavoritesStore = globalThis.__useBoardFavoritesStore;',
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
      "from '../shared/board-task-list.js'",
      `from "${LIST_URL}"`,
    );
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )).default;
}

test('UI-04/07: BoardView переключает favoriteOnly и передаёт строке правильную задачу', async (t) => {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/board' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
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
  globalThis.__useBoardFavoritesBoardStore = defineStore('board-favorites-board', {
    state: () => ({
      data: {
        userId: 7,
        today: { hours: 0, tasks_count: 0, avg_time: 0 },
        dynamics: {},
        month: { hours: 0, norm: 1 },
        charts: {},
        tasks: [
          { id: 11, title: 'Избранная задача', group: 'A', timerElapsed: 0 },
          { id: 22, title: 'Обычная задача', group: 'B', timerElapsed: 0 },
        ],
        toReview: [],
        created: [],
      },
      error: null,
      loading: false,
    }),
    actions: { async load() {}, markTasksSeen() {} },
  });
  globalThis.__useBoardFavoritesUiStore = defineStore('board-favorites-ui', {
    actions: { openTask() {} },
  });
  globalThis.__useBoardFavoritesAnalysisStore = defineStore('board-favorites-analysis', {
    state: () => ({ byTask: {} }),
    actions: { startPolling() {}, async analyze() {} },
  });
  globalThis.__useBoardFavoritesStore = defineStore('board-favorites', {
    state: () => ({
      taskIds: ['11'],
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
      async toggle(id) { toggled.push(String(id)); return true; },
    },
  });
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
    browser.close();
    delete globalThis.__useBoardFavoritesBoardStore;
    delete globalThis.__useBoardFavoritesUiStore;
    delete globalThis.__useBoardFavoritesAnalysisStore;
    delete globalThis.__useBoardFavoritesStore;
  });
  await flushPromises();

  assert.equal(wrapper.findAll('li.trow').length, 2);
  const filter = wrapper.get('button.favfilter');
  assert.match(filter.text(), /1/);
  assert.equal(filter.attributes('aria-pressed'), 'false');

  const projectBadges = wrapper.findAll('.project-badge');
  assert.deepEqual(projectBadges.map((badge) => badge.text()), ['A', 'B']);
  assert.equal(projectBadges[0].attributes('title'), 'Проект: A');
  assert.equal(projectBadges[0].attributes('aria-label'), 'Проект: A');
  const firstRowChildren = [...wrapper.get('li.trow').element.children];
  assert.ok(firstRowChildren.indexOf(wrapper.get('button.stub-fav').element)
    < firstRowChildren.indexOf(projectBadges[0].element));
  assert.ok(firstRowChildren.indexOf(projectBadges[0].element)
    < firstRowChildren.indexOf(wrapper.get('button.ttext').element));

  await filter.trigger('click');
  await flushPromises();
  assert.equal(filter.attributes('aria-pressed'), 'true');
  assert.equal(wrapper.findAll('li.trow').length, 1);
  assert.match(wrapper.get('li.trow').text(), /Избранная задача/);

  await wrapper.get('button.stub-fav').trigger('click');
  assert.deepEqual(toggled, ['11']);
});
