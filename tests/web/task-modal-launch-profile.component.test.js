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
  );  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: 'data-v-task-modal-launch-profile-test',
    inlineTemplate: true,
  }).content;
  code = code
    .replaceAll('from "vue"', 'from "' + VUE_URL + '"')
    .replaceAll("from 'vue'", "from '" + VUE_URL + "'")
    .replaceAll("from 'pinia'", "from '" + PINIA_URL + "'")
    .replace(
      "import { useRouter } from 'vue-router';",
      'const useRouter = () => ({ push() {} });',
    )
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = globalThis.__taskModalLaunchApi;',
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
      'const useUiStore = globalThis.__taskModalLaunchUiStore;',
    )
    .replace(
      "import { useTasksStore } from '../stores/tasks.js';",
      'const useTasksStore = globalThis.__taskModalLaunchTasksStore;',
    )
    .replace(
      "import { useBoardStore } from '../stores/board.js';",
      'const useBoardStore = globalThis.__taskModalLaunchBoardStore;',
    )
    .replace(
      "import { useAnalysisStore } from '../stores/analysis.js';",
      'const useAnalysisStore = globalThis.__taskModalLaunchAnalysisStore;',
    )
    .replace(
      "import { useTaskFavoritesStore } from '../stores/task-favorites.js';",
      'const useTaskFavoritesStore = globalThis.__taskModalLaunchFavoriteStore;',
    )
    .replace(
      "import { useTaskSeenStore } from '../stores/task-seen.js';",
      'const useTaskSeenStore = globalThis.__taskModalLaunchSeenStore;',
    )
    .replace(
      "import { liveTimerSec, secToHMS } from '../shared/format.js';",
      'const liveTimerSec = () => 0; const secToHMS = (n) => String(n ?? 0);',
    )
    .replace(
      "import { mdToHtml } from '../shared/md.js';",
      'const mdToHtml = (value) => String(value || "");',
    )
    .replace(
      "import { providerLabel } from '../shared/runner-display.js';",
      'const { providerLabel } = globalThis.__taskModalLaunchRunnerDisplay;',
    )
    .replace(
      "import OpenDiffButton from './OpenDiffButton.vue';",
      'const OpenDiffButton = { template: "<span></span>" };',
    )
    .replace(
      "import TaskFavoriteButton from './board/TaskFavoriteButton.vue';",
      'const TaskFavoriteButton = { props: ["active", "pending", "taskTitle"], template: "<span></span>" };',
    );
  // Уникальный хвост: иначе data: URL совпадает между тестами, import отдаёт кеш
  // модуля, и компонент навсегда остаётся склеен с заглушками ПЕРВОГО теста.
  compileTaskModal.seq = (compileTaskModal.seq || 0) + 1;
  return (await import(
    'data:text/javascript;base64,'
    + Buffer.from(`${code}\n// compile #${compileTaskModal.seq}`).toString('base64')
  )).default;
}

// Общий стенд для сценариев формы запуска: happy-dom + заглушки сторов.
// launchOptions/launch задаёт тест, остальные вызовы — безобидные пустышки.
async function mountLaunchForm(t, { launchOptions }) {
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
  const launchCalls = [];
  globalThis.__taskModalLaunchApi = {
    async get(url) {
      if (url.endsWith('/clarifications')) return { text: '' };
      if (url === '/api/tasks') return { tasks: [] };
      return {};
    },
    async post() { return {}; },
    async upload() { return {}; },
  };
  globalThis.__taskModalLaunchRunnerDisplay = await import('../../web/src/shared/runner-display.js');
  globalThis.__taskModalLaunchUiStore = defineStore('task-modal-launch-ui', {
    state: () => ({ taskId: 42 }),
    actions: { close() {} },
  });
  globalThis.__taskModalLaunchTasksStore = defineStore('task-modal-launch-tasks', {
    actions: {
      async load() { return { title: 'Экспорт чертежа', description: 'Проверить GLB' }; },
      async timer() {},
      async complete() {},
      async comment() {},
      launchOptions,
      async launch(id, payload) {
        launchCalls.push([String(id), payload]);
        return { outcome: 'launched', profile: payload.profile, route: payload.route };
      },
    },
  });
  globalThis.__taskModalLaunchBoardStore = defineStore('task-modal-launch-board', {
    state: () => ({
      data: {
        tasks: [{ id: 42, title: 'Экспорт чертежа', group: 'RDesigner' }],
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
  globalThis.__taskModalLaunchFavoriteStore = defineStore('task-modal-launch-favorite', {
    state: () => ({ taskIds: [], loaded: true, loading: false, error: null, pending: {} }),
    getters: {
      isFavorite: () => () => false,
      isPending: () => () => false,
    },
    actions: { async load() {}, async toggle() {} },
  });
  // Открытая задача перестаёт быть новой; форме запуска отметка безразлична.
  globalThis.__taskModalLaunchSeenStore = defineStore('task-modal-launch-seen', {
    state: () => ({ taskIds: [], loaded: true, initialized: true, loading: false, error: null }),
    getters: {
      isSeen: () => () => false,
      ready: () => true,
    },
    actions: { async load() {}, async markSeen() { return true; } },
  });

  const wrapper = mount(await compileTaskModal(), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()] },
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
      '__taskModalLaunchFavoriteStore',
      '__taskModalLaunchSeenStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  return { wrapper, flushPromises, launchCalls };
}

test('TaskModal выбирает rdesigner, перечитывает feature и шлёт profile в launch', async (t) => {
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
  const optionCalls = [];
  const launchCalls = [];
  globalThis.__taskModalLaunchRunnerDisplay = await import('../../web/src/shared/runner-display.js');
  globalThis.__taskModalLaunchApi = {
    async get(url) {
      if (url.endsWith('/clarifications')) return { text: '' };
      if (url === '/api/tasks') return { tasks: [] };
      return {};
    },
    async post() { return {}; },
    async upload() { return {}; },
  };
  globalThis.__taskModalLaunchUiStore = defineStore('task-modal-launch-ui', {
    state: () => ({ taskId: 42 }),
    actions: { close() {} },
  });
  globalThis.__taskModalLaunchTasksStore = defineStore('task-modal-launch-tasks', {
    actions: {
      async load() { return { title: 'Экспорт чертежа', description: 'Проверить GLB' }; },
      async timer() {},
      async complete() {},
      async comment() {},
      async launchOptions(id, profile = '') {
        optionCalls.push([String(id), profile]);
        if (profile === 'rdesigner') {
          return {
            profile: 'rdesigner',
            profiles: ['rdesigner'],
            routes: ['consilium-debug', 'feature'],
            defaultRoute: 'feature',
            routeOptions: {
              'consilium-debug': { deliveryMode: 'publish', instrumentationRequired: true },
              feature: { deliveryMode: 'publish', instrumentationRequired: false },
            },
            repositories: [{ name: 'rdesigner', targetBranch: 'master' }],
            instrumentationSuggestions: ['rdesigner:webapp/pipeline.py'],
            diagnosisSuggestion: { kind: 'data', signal: 'GLB экспорт повреждён' },
            profileContractError: null,
          };
        }
        return {
          profile: 'arsenkin',
          profiles: ['arsenkin', 'rdesigner'],
          routes: [],
          defaultRoute: null,
          error: 'no_catalog',
          message: 'каталог маршрутов профиля не опубликован',
        };
      },
      async launch(id, payload) {
        launchCalls.push([String(id), payload]);
        return { outcome: 'launched', profile: payload.profile, route: payload.route };
      },
    },
  });
  globalThis.__taskModalLaunchBoardStore = defineStore('task-modal-launch-board', {
    state: () => ({
      data: {
        tasks: [{ id: 42, title: 'Экспорт чертежа', group: 'RDesigner' }],
        toReview: [], created: [], accomplice: [], auditor: [],
      },
    }),
    actions: { async load() {} },
  });
  globalThis.__taskModalLaunchAnalysisStore = defineStore('task-modal-launch-analysis', {
    actions: {
      async detail() { return { analysis: { route_guess: 'feature' } }; },
      async analyze() {},
    },
  });
  globalThis.__taskModalLaunchFavoriteStore = defineStore('task-modal-launch-favorite', {
    state: () => ({ taskIds: [], loaded: true, loading: false, error: null, pending: {} }),
    getters: {
      isFavorite: () => () => false,
      isPending: () => () => false,
    },
    actions: { async load() {}, async toggle() {} },
  });
  // Открытая задача перестаёт быть новой; форме запуска отметка безразлична.
  globalThis.__taskModalLaunchSeenStore = defineStore('task-modal-launch-seen', {
    state: () => ({ taskIds: [], loaded: true, initialized: true, loading: false, error: null }),
    getters: {
      isSeen: () => () => false,
      ready: () => true,
    },
    actions: { async load() {}, async markSeen() { return true; } },
  });

  const wrapper = mount(await compileTaskModal(), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()] },
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
      '__taskModalLaunchFavoriteStore',
      '__taskModalLaunchSeenStore',
    ]) delete globalThis[key];
  });
  await flushPromises();

  await wrapper.get('button.launch').trigger('click');
  await flushPromises();
  const profile = wrapper.get('#launch-profile');
  assert.deepEqual(profile.findAll('option').map((option) => option.text()), ['arsenkin', 'rdesigner']);
  assert.match(wrapper.text(), /каталог маршрутов профиля не опубликован/);
  assert.equal(wrapper.get('.lbtns .primary').attributes('disabled'), '');

  await profile.setValue('rdesigner');
  await flushPromises();
  assert.equal(wrapper.get('#launch-route').element.value, 'feature');
  assert.match(wrapper.text(), /debug/);
  assert.equal(wrapper.find('#launch-profile').exists(), false);
  assert.match(wrapper.get('[aria-label="Параметры запуска"]').text(), /rdesigner/);
  assert.match(wrapper.get('[aria-label="Параметры запуска"]').text(), /rdesigner\/master/);
  assert.equal(wrapper.find('[aria-label="Целевая ветка rdesigner"]').exists(), false);
  assert.equal(wrapper.get('.ladvanced').attributes('open'), undefined);
  assert.match(wrapper.get('.ladvanced').text(), /Целевые ветки из конфигурации профиля/);

  await wrapper.get('#launch-route').setValue('consilium-debug');
  await flushPromises();
  assert.equal(wrapper.get('#launch-instrumentation').element.value, 'rdesigner:webapp/pipeline.py');
  assert.equal(wrapper.get('#launch-diagnosis-kind').element.value, 'data');
  assert.equal(wrapper.get('#launch-diagnosis-signal').element.value, 'GLB экспорт повреждён');
  await wrapper.get('#launch-route').setValue('feature');
  await flushPromises();

  await wrapper.get('.lbtns .primary').trigger('click');
  await flushPromises();
  assert.deepEqual(optionCalls, [['42', ''], ['42', 'rdesigner']]);
  assert.equal(launchCalls.length, 1);
  assert.equal(launchCalls[0][0], '42');
  assert.equal(launchCalls[0][1].profile, 'rdesigner');
  assert.equal(launchCalls[0][1].route, 'feature');
  assert.equal(launchCalls[0][1].title, 'Экспорт чертежа');
  assert.deepEqual(launchCalls[0][1].acceptanceCriteria, []);
  assert.equal(Object.hasOwn(launchCalls[0][1], 'deliveryTargets'), false);
  assert.deepEqual(launchCalls[0][1].instrumentationFiles, []);
  assert.equal(Object.hasOwn(launchCalls[0][1], 'ticket'), false);
  assert.equal(Object.hasOwn(launchCalls[0][1], 'generation'), false);
  assert.equal(Object.hasOwn(launchCalls[0][1], 'runnerPrimary'), false);
});

test('TaskModal: исполнитель по умолчанию «из профиля», runnerPrimary уходит только при явном выборе', async (t) => {
  const { wrapper, flushPromises, launchCalls } = await mountLaunchForm(t, {
    launchOptions: async () => ({
      profile: 'arsenkin',
      profiles: ['arsenkin'],
      routes: ['feature'],
      defaultRoute: 'feature',
      routeOptions: { feature: { deliveryMode: 'publish', instrumentationRequired: false } },
      repositories: [{ name: 'arsenkin', targetBranch: 'main' }],
      runners: ['claude', 'codex'],
      defaultRunner: 'claude',
    }),
  });

  await wrapper.get('button.launch').trigger('click');
  await flushPromises();

  const runner = wrapper.get('#launch-runner');
  assert.deepEqual(
    runner.findAll('option').map((option) => option.text()),
    ['Из профиля (Claude)', 'Claude', 'Codex'],
  );
  assert.equal(runner.element.value, '');

  // Без выбора исполнителя payload его не несёт — решение остаётся за профилем.
  await wrapper.get('.lbtns .primary').trigger('click');
  await flushPromises();
  assert.equal(launchCalls.length, 1);
  assert.equal(Object.hasOwn(launchCalls[0][1], 'runnerPrimary'), false);

  // Явный выбор — runnerPrimary уезжает в launch.
  await wrapper.get('button.launch').trigger('click');
  await flushPromises();
  await wrapper.get('#launch-runner').setValue('codex');
  await wrapper.get('.lbtns .primary').trigger('click');
  await flushPromises();
  assert.equal(launchCalls.length, 2);
  assert.equal(launchCalls[1][1].runnerPrimary, 'codex');
});

test('TaskModal: смена профиля сбрасывает выбор исполнителя на «из профиля»', async (t) => {
  const catalog = (override) => ({
    profiles: ['arsenkin', 'rdesigner'],
    routes: ['feature'],
    defaultRoute: 'feature',
    routeOptions: { feature: { deliveryMode: 'publish', instrumentationRequired: false } },
    repositories: [{ name: 'repo', targetBranch: 'main' }],
    ...override,
  });
  const { wrapper, flushPromises, launchCalls } = await mountLaunchForm(t, {
    launchOptions: async (id, profile = '') => (profile === 'rdesigner'
      ? catalog({ profile: 'rdesigner', runners: ['codex'], defaultRunner: 'codex' })
      : catalog({ profile: 'arsenkin', runners: ['claude', 'codex'], defaultRunner: 'claude' })),
  });

  await wrapper.get('button.launch').trigger('click');
  await flushPromises();
  await wrapper.get('#launch-runner').setValue('codex');
  assert.equal(wrapper.get('#launch-runner').element.value, 'codex');

  // У нового профиля свой набор исполнителей и свой primary — прошлый выбор терять обязаны.
  await wrapper.get('#launch-profile').setValue('rdesigner');
  await flushPromises();
  const runner = wrapper.get('#launch-runner');
  assert.equal(runner.element.value, '');
  assert.deepEqual(
    runner.findAll('option').map((option) => option.text()),
    ['Из профиля (Codex)', 'Codex'],
  );

  await wrapper.get('.lbtns .primary').trigger('click');
  await flushPromises();
  assert.equal(launchCalls.length, 1);
  assert.equal(launchCalls[0][1].profile, 'rdesigner');
  assert.equal(Object.hasOwn(launchCalls[0][1], 'runnerPrimary'), false);
});
