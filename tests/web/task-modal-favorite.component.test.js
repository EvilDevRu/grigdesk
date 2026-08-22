import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const VIEW_PATH = fileURLToPath(new URL('../../web/src/views/TaskModal.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;

async function compileTaskModal() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: 'data-v-task-modal-favorite-test',
    inlineTemplate: true,
  }).content;
  code = code
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replaceAll("from 'pinia'", `from "${PINIA_URL}"`)
    .replace(
      "import { useRouter } from 'vue-router';",
      'const useRouter = () => ({ push() {} });',
    )
    .replace(
      "import { useUiContextSource } from '../composables/useUiContextSource.js';",
      'const useUiContextSource = () => ({ focus() {}, update() {}, blur() {} });',
    )
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = globalThis.__taskModalFavoriteApi;',
    )
    .replace(
      "import { confirmDialog } from '../shared/ui/confirm.js';",
      'const confirmDialog = async () => true;',
    )
    .replace(
      "import { registerLayer } from '../shared/ui/layer-stack.js';",
      'const registerLayer = () => () => {};',
    )
    .replace(
      "import HelpTip from '../shared/ui/HelpTip.vue';",
      'const HelpTip = { template: "<span><slot /><slot name=\\"tip\\" /></span>" };',
    )
    .replace(
      "import { useUiStore } from '../stores/ui.js';",
      'const useUiStore = globalThis.__taskModalFavoriteUiStore;',
    )
    .replace(
      "import { useTasksStore } from '../stores/tasks.js';",
      'const useTasksStore = globalThis.__taskModalFavoriteTasksStore;',
    )
    .replace(
      "import { useBoardStore } from '../stores/board.js';",
      'const useBoardStore = globalThis.__taskModalFavoriteBoardStore;',
    )
    .replace(
      "import { useAnalysisStore } from '../stores/analysis.js';",
      'const useAnalysisStore = globalThis.__taskModalFavoriteAnalysisStore;',
    )
    .replace(
      "import { useTaskFavoritesStore } from '../stores/task-favorites.js';",
      'const useTaskFavoritesStore = globalThis.__taskModalFavoriteStore;',
    )
    .replace(
      "import { useTaskSeenStore } from '../stores/task-seen.js';",
      'const useTaskSeenStore = globalThis.__taskModalFavoriteSeenStore;',
    )
    .replace(
      "import { liveTimerSec, secToHMS } from '../shared/format.js';",
      'const liveTimerSec = (task) => task?.timerElapsed || 0; const secToHMS = (n) => String(n ?? 0);',
    )
    .replace(
      "import { mdToHtml } from '../shared/md.js';",
      'const mdToHtml = (value) => String(value || "");',
    )
    .replace(
      "import { providerLabel } from '../shared/runner-display.js';",
      'const { providerLabel } = globalThis.__taskModalFavoriteRunnerDisplay;',
    )
    .replace(
      "import OpenDiffButton from './OpenDiffButton.vue';",
      'const OpenDiffButton = { template: "<span></span>" };',
    )
    .replace(
      "import TaskFavoriteButton from './board/TaskFavoriteButton.vue';",
      `const TaskFavoriteButton = {
        props: ["active", "pending", "taskTitle"],
        emits: ["toggle"],
        template: '<button class="stub-modal-fav" :aria-pressed="String(active)" @click="$emit(\\'toggle\\')">{{ taskTitle }}</button>',
      };`,
    );
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )).default;
}

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
  globalThis.__taskModalFavoriteStore = defineStore('task-modal-favorite', {
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
  globalThis.__taskModalFavoriteRunnerDisplay = await import('../../web/src/shared/runner-display.js');
  const TaskModal = await compileTaskModal();
  const wrapper = mount(TaskModal, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia] },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__taskModalFavoriteApi',
      '__taskModalFavoriteRunnerDisplay',
      '__taskModalFavoriteUiStore',
      '__taskModalFavoriteTasksStore',
      '__taskModalFavoriteBoardStore',
      '__taskModalFavoriteAnalysisStore',
      '__taskModalFavoriteStore',
      '__taskModalFavoriteSeenStore',
    ]) delete globalThis[key];
  });
  await flushPromises();

  // Метка «новая» снимается именно открытием задачи — это единственное место,
  // где кокпит узнаёт, что человек её прочитал.
  assert.deepEqual(markedSeen, [['42']]);

  const button = wrapper.get('button.stub-modal-fav');
  assert.equal(button.attributes('aria-pressed'), 'false');
  assert.match(button.text(), /Задача 42/);
  await button.trigger('click');
  await flushPromises();

  assert.deepEqual(toggled, ['42']);
  assert.match(wrapper.text(), /Не удалось сохранить звезду/);
});
