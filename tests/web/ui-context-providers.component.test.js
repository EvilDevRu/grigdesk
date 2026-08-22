// Проверяет, как поставщики UI-контекста страницы регистрируются, обновляются и передают снимки.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const root = new URL('../../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;

function replaceRequired(code, needle, replacement, label) {
  const next = code.replace(needle, replacement);
  assert.notEqual(next, code, `не найден import ${label}`);
  return next;
}

async function compilePublisher(path, id, transform) {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const filename = fileURLToPath(new URL(`../../${path}`, import.meta.url));
  const text = await readFile(filename, 'utf8');
  const { descriptor, errors } = parse(text, { filename });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, { id, inlineTemplate: true }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from '${VUE_URL}'`)
    .replaceAll('from "pinia"', `from "${PINIA_URL}"`)
    .replaceAll("from 'pinia'", `from '${PINIA_URL}'`);
  code = transform(code);
  compilePublisher.revision = (compilePublisher.revision || 0) + 1;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(`${code}\n// publisher ${compilePublisher.revision}`).toString('base64')}`
  )).default;
}

async function browserHarness() {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/pipeline' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
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
  return browser;
}

async function compilePipelinePublisher() {
  return compilePublisher(
    'web/src/views/PipelineView.vue',
    'data-v-ui-context-pipeline-runtime',
    (input) => {
      let code = input;
      code = replaceRequired(
        code,
        "import { api } from '../shared/api-client.js';",
        'const api = globalThis.__uiContextPipelineApi;',
        'Pipeline api',
      );
      code = replaceRequired(
        code,
        "import { useSse } from '../composables/useSse.js';",
        'const useSse = () => {};',
        'Pipeline SSE',
      );
      code = replaceRequired(
        code,
        "import { useUiContextSource } from '../composables/useUiContextSource.js';",
        'const useUiContextSource = globalThis.__uiContextSourceHelper;',
        'Pipeline ui-context source',
      );
      code = replaceRequired(
        code,
        "import { useUiStore } from '../stores/ui.js';",
        'const useUiStore = globalThis.__uiContextUiStore;',
        'Pipeline UI store',
      );
      code = replaceRequired(
        code,
        "import { useTasksStore } from '../stores/tasks.js';",
        'const useTasksStore = globalThis.__uiContextTasksStore;',
        'Pipeline tasks store',
      );
      code = replaceRequired(
        code,
        "import { useBoardStore } from '../stores/board.js';",
        'const useBoardStore = globalThis.__uiContextBoardStore;',
        'Pipeline board store',
      );
      code = replaceRequired(
        code,
        "import { useCompanionStore } from '../stores/companion.js';",
        'const useCompanionStore = globalThis.__uiContextCompanionStore;',
        'Pipeline companion store',
      );
      code = replaceRequired(
        code,
        "import { liveTimerSec, pipelineWorkSec, secToHMS } from '../shared/format.js';",
        'const liveTimerSec = () => 0; const pipelineWorkSec = () => null; const secToHMS = (value) => String(value ?? 0);',
        'Pipeline format',
      );
      code = replaceRequired(
        code,
        "import { mdToHtml } from '../shared/md.js';",
        'const mdToHtml = (value) => String(value || "");',
        'Pipeline markdown',
      );
      code = replaceRequired(
        code,
        "import { confirmDialog, alertDialog } from '../shared/ui/confirm.js';",
        'const confirmDialog = async () => true; const alertDialog = async () => {};',
        'Pipeline dialogs',
      );
      code = replaceRequired(
        code,
        "import { sandboxUrl } from '../shared/sandbox.js';",
        'const sandboxUrl = (port) => `http://sandbox.test:${port}`;',
        'Pipeline sandbox',
      );
      code = replaceRequired(
        code,
        "import { agentActivityLabel } from '../shared/agent-activity.js';",
        'const agentActivityLabel = () => "";',
        'Pipeline activity',
      );
      code = replaceRequired(
        code,
        "import { waitingReason, stripEmoji } from '../shared/pipeline-wait.js';",
        'const { waitingReason, stripEmoji } = globalThis.__uiContextPipelineWait;',
        'Pipeline wait helpers',
      );
      code = replaceRequired(
        code,
        /import \{[^}]*\} from '\.\.\/shared\/runner-display\.js';/,
        'const { attemptCostLabel, attemptCostTitle, attemptResultLabel, providerLabel, runnerAttemptModelLabel, runnerChainLabel, runnerModelEffortLabel, runnerNodeLabel, runnerReasonLabel } = globalThis.__uiContextRunnerDisplay;',
        'Pipeline runner helpers',
      );
      code = replaceRequired(
        code,
        "import FactoryGraph from './pipeline/FactoryGraph.vue';",
        'const FactoryGraph = globalThis.__uiContextFactoryGraph;',
        'Pipeline graph',
      );
      return replaceRequired(
        code,
        "import OpenDiffButton from './OpenDiffButton.vue';",
        'const OpenDiffButton = { template: "<span></span>" };',
        'Pipeline diff button',
      );
    },
  );
}

async function compileTaskModalPublisher() {
  return compilePublisher(
    'web/src/views/TaskModal.vue',
    'data-v-ui-context-task-runtime',
    (input) => {
      let code = input;
      code = replaceRequired(
        code,
        "import { useRouter } from 'vue-router';",
        'const useRouter = () => ({ push() {} });',
        'TaskModal router',
      );
      code = replaceRequired(
        code,
        "import { api } from '../shared/api-client.js';",
        'const api = globalThis.__uiContextTaskApi;',
        'TaskModal api',
      );
      code = replaceRequired(
        code,
        "import { useUiContextSource } from '../composables/useUiContextSource.js';",
        'const useUiContextSource = globalThis.__uiContextSourceHelper;',
        'TaskModal ui-context source',
      );
      code = replaceRequired(
        code,
        "import { confirmDialog } from '../shared/ui/confirm.js';",
        'const confirmDialog = async () => true;',
        'TaskModal dialog',
      );
      code = replaceRequired(
        code,
        "import { registerLayer } from '../shared/ui/layer-stack.js';",
        'const registerLayer = () => () => {};',
        'TaskModal layer',
      );
      code = replaceRequired(
        code,
        "import HelpTip from '../shared/ui/HelpTip.vue';",
        'const HelpTip = { template: "<span><slot /><slot name=\\"tip\\" /></span>" };',
        'TaskModal help',
      );
      for (const [path, globalName, label] of [
        ["../stores/ui.js", '__uiContextUiStore', 'UI'],
        ["../stores/tasks.js", '__uiContextTasksStore', 'tasks'],
        ["../stores/board.js", '__uiContextBoardStore', 'board'],
        ["../stores/analysis.js", '__uiContextAnalysisStore', 'analysis'],
        ["../stores/task-favorites.js", '__uiContextFavoritesStore', 'favorites'],
        ["../stores/task-seen.js", '__uiContextSeenStore', 'seen'],
      ]) {
        const exported = {
          UI: 'useUiStore', tasks: 'useTasksStore', board: 'useBoardStore',
          analysis: 'useAnalysisStore', favorites: 'useTaskFavoritesStore', seen: 'useTaskSeenStore',
        }[label];
        code = replaceRequired(
          code,
          `import { ${exported} } from '${path}';`,
          `const ${exported} = globalThis.${globalName};`,
          `TaskModal ${label} store`,
        );
      }
      code = replaceRequired(
        code,
        "import { liveTimerSec, secToHMS } from '../shared/format.js';",
        'const liveTimerSec = () => 0; const secToHMS = (value) => String(value ?? 0);',
        'TaskModal format',
      );
      code = replaceRequired(
        code,
        "import { mdToHtml } from '../shared/md.js';",
        'const mdToHtml = (value) => String(value || "");',
        'TaskModal markdown',
      );
      code = replaceRequired(
        code,
        "import { providerLabel } from '../shared/runner-display.js';",
        'const { providerLabel } = globalThis.__uiContextRunnerDisplay;',
        'TaskModal runner helper',
      );
      code = replaceRequired(
        code,
        "import OpenDiffButton from './OpenDiffButton.vue';",
        'const OpenDiffButton = { template: "<span></span>" };',
        'TaskModal diff button',
      );
      return replaceRequired(
        code,
        "import TaskFavoriteButton from './board/TaskFavoriteButton.vue';",
        'const TaskFavoriteButton = { props: ["active", "pending", "taskTitle"], emits: ["toggle"], template: "<button />" };',
        'TaskModal favorite button',
      );
    },
  );
}

async function compileToolHostPublisher() {
  return compilePublisher(
    'web/src/shared/layout/ToolHost.vue',
    'data-v-ui-context-tool-runtime',
    (input) => {
      let code = input;
      code = replaceRequired(
        code,
        "import { useRoute, useRouter } from 'vue-router';",
        'const useRoute = () => globalThis.__uiContextToolRoute; const useRouter = () => ({ push() {} });',
        'ToolHost router',
      );
      code = replaceRequired(
        code,
        "import { useDockStore, MIN_DOCK_WIDTH } from '../../stores/dock.js';",
        'const { useDockStore, MIN_DOCK_WIDTH } = globalThis.__uiContextDockModule;',
        'ToolHost dock store',
      );
      code = replaceRequired(
        code,
        "import { usePluginsStore } from '../../stores/plugins.js';",
        'const usePluginsStore = globalThis.__uiContextPluginsStore;',
        'ToolHost plugins store',
      );
      code = replaceRequired(
        code,
        "import { useUiContextSource } from '../../composables/useUiContextSource.js';",
        'const useUiContextSource = globalThis.__uiContextSourceHelper;',
        'ToolHost ui-context source',
      );
      code = replaceRequired(
        code,
        "import { NAV_ICONS } from '../nav-icons.js';",
        'const NAV_ICONS = { code: "", plugin: "" };',
        'ToolHost icons',
      );
      code = replaceRequired(
        code,
        "import { registerLayer } from '../ui/layer-stack.js';",
        'const registerLayer = () => () => {};',
        'ToolHost layer',
      );
      code = replaceRequired(
        code,
        "import { TOOL_REGISTRY, TOOL_BY_ID, toolAvailability } from '../tools/registry.js';",
        'const { TOOL_REGISTRY, TOOL_BY_ID, toolAvailability } = globalThis.__uiContextToolRegistry;',
        'ToolHost registry',
      );
      code = replaceRequired(
        code,
        "import { useDockViewport } from '../tools/viewport.js';",
        'const useDockViewport = () => ({ dockCapable: globalThis.__uiContextDockCapable });',
        'ToolHost viewport',
      );
      return replaceRequired(
        code,
        "import ToolDock from './ToolDock.vue';",
        'const ToolDock = globalThis.__uiContextToolDock;',
        'ToolHost dock component',
      );
    },
  );
}

test('COMP-PROV-09/10: owner dispose и explicit focus управляют scope без focus theft от details update', async (t) => {
  const browser = await browserHarness();
  const [{ mount }, { computed, defineComponent, h, nextTick }, { createPinia, setActivePinia }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const [{ useUiContextStore }, { useUiContextSource }] = await Promise.all([
    import('../../web/src/stores/ui-context.js'),
    import('../../web/src/composables/useUiContextSource.js'),
  ]);

  const pinia = createPinia();
  setActivePinia(pinia);
  let sourceOwner = null;
  const Provider = defineComponent({
    setup() {
      sourceOwner = useUiContextSource('pipeline', {
        layer: 'overlay',
        routingScope: { kind: 'task', taskId: '101' },
        details: { taskId: '101', stageId: 'build' },
      });
      return () => h('div');
    },
  });
  const wrapper = mount(Provider, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia] },
  });
  t.after(() => { if (wrapper.exists()) wrapper.unmount(); });

  const ui = useUiContextStore();
  const observedStage = computed(() => (
    ui.capture({ path: '/pipeline' }).promptContext.details?.pipeline?.stageId
  ));
  assert.equal(observedStage.value, 'build');
  const modal = ui.register('task', {
    layer: 'overlay',
    routingScope: { kind: 'task', taskId: '202' },
    details: { taskId: '202', title: 'Поверх конвейера' },
  });
  assert.equal(ui.capture({ path: '/pipeline' }).routingScope.taskId, '202');

  sourceOwner.update({
    routingScope: { kind: 'task', taskId: '101' },
    details: { taskId: '101', stageId: 'review' },
  });
  await nextTick();
  assert.equal(observedStage.value, 'review', 'stable descriptor update остаётся реактивным');
  assert.equal(
    ui.capture({ path: '/pipeline' }).routingScope.taskId,
    '202',
    'фоновое обновление деталей Pipeline не становится новым focus',
  );

  // Предыдущий register(modal) уже инвалидировал computed и мог скрыть отсутствие
  // собственной invalidation у sourceOwner.update(). Второе обновление идёт без
  // каких-либо registry mutations и обязано само пометить snapshot dirty.
  sourceOwner.update({
    routingScope: { kind: 'task', taskId: '101' },
    details: { taskId: '101', stageId: 'ship' },
  });
  await nextTick();
  assert.equal(observedStage.value, 'ship', 'каждый owner update инвалидирует computed capture');

  sourceOwner.focus();
  assert.equal(ui.capture({ path: '/pipeline' }).routingScope.taskId, '101');
  modal.focus();
  assert.equal(ui.capture({ path: '/pipeline' }).routingScope.taskId, '202');
  modal.dispose();
  assert.equal(ui.capture({ path: '/pipeline' }).routingScope.taskId, '101');

  wrapper.unmount();
  assert.equal(ui.capture({ path: '/pipeline' }).routingScope, null);
});

test('COMP-PROV-11: реальные Pipeline stage и TaskModal сохраняют exact scope при race/unmount', async (t) => {
  const browser = await browserHarness();
  browser.document.body.innerHTML = '<div id="pipeline-mount"></div><div id="task-mount"></div>';
  const [
    { mount, flushPromises },
    { createPinia, defineStore, setActivePinia },
    { nextTick },
    { useUiContextStore },
    { useUiContextSource },
  ] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/src/stores/ui-context.js'),
    import('../../web/src/composables/useUiContextSource.js'),
  ]);

  const pinia = createPinia();
  setActivePinia(pinia);
  let pipelineWrapper = null;
  let taskWrapper = null;
  t.after(() => {
    if (taskWrapper?.exists()) taskWrapper.unmount();
    if (pipelineWrapper?.exists()) pipelineWrapper.unmount();
    browser.close();
    for (const key of [
      '__uiContextPipelineApi', '__uiContextTaskApi', '__uiContextSourceHelper',
      '__uiContextUiStore', '__uiContextTasksStore', '__uiContextBoardStore',
      '__uiContextCompanionStore', '__uiContextAnalysisStore', '__uiContextFavoritesStore',
      '__uiContextSeenStore', '__uiContextPipelineWait', '__uiContextRunnerDisplay',
      '__uiContextFactoryGraph',
    ]) delete globalThis[key];
  });

  globalThis.__uiContextSourceHelper = useUiContextSource;
  globalThis.__uiContextUiStore = defineStore('ui-context-runtime-ui', {
    state: () => ({ taskId: null, launchRequested: false }),
    actions: {
      openTask(id) { this.taskId = String(id); },
      openTaskLaunch(id) { this.launchRequested = true; this.taskId = String(id); },
      consumeTaskLaunch() { this.launchRequested = false; },
      close() { this.taskId = null; this.launchRequested = false; },
    },
  });
  globalThis.__uiContextTasksStore = defineStore('ui-context-runtime-tasks', {
    actions: {
      async load(id) { return { id, title: `Задача ${id}`, description: '' }; },
      title(id) { return `Задача ${id}`; },
      async launchQueue() {
        return { revision: 0, enabled: false, items: [], completed: [], worker: {} };
      },
      async factorySlots() { return { profile: '', slots: [] }; },
      async timer() {},
      async complete() {},
      async comment() {},
      async launch() { return {}; },
      async enqueueLaunch() { return { items: [] }; },
      async setStageRunner() {},
    },
  });
  globalThis.__uiContextBoardStore = defineStore('ui-context-runtime-board', {
    state: () => ({
      data: {
        tasks: [{ id: 202, title: 'Задача 202', timerRunning: false }],
        toReview: [], created: [], accomplice: [], auditor: [],
      },
    }),
    actions: { async load() {} },
  });
  globalThis.__uiContextCompanionStore = defineStore('ui-context-runtime-companion', {
    actions: { async openForTask() {} },
  });
  globalThis.__uiContextAnalysisStore = defineStore('ui-context-runtime-analysis', {
    actions: { async detail() { return {}; }, async analyze() {} },
  });
  globalThis.__uiContextFavoritesStore = defineStore('ui-context-runtime-favorites', {
    state: () => ({ taskIds: [], loaded: true, loading: false, error: null, pending: {} }),
    getters: {
      isFavorite: (state) => (id) => state.taskIds.includes(String(id)),
      isPending: (state) => (id) => !!state.pending[String(id)],
    },
    actions: { async load() {}, async toggle() {} },
  });
  globalThis.__uiContextSeenStore = defineStore('ui-context-runtime-seen', {
    state: () => ({ taskIds: [], loaded: true, initialized: true, loading: false, error: null }),
    getters: {
      isSeen: (state) => (id) => state.taskIds.includes(String(id)),
      ready: (state) => state.loaded && state.initialized,
    },
    actions: { async load() {}, async markSeen() { return true; } },
  });

  const factoryTask = {
    task: 101,
    profile: 'test',
    route: 'feature',
    readOnly: false,
    workspaceMode: 'isolated',
    daemonAlive: false,
    stall: null,
  };
  const graph = {
    route: 'feature',
    readOnly: false,
    daemonAlive: false,
    nodes: { review: [0, '🔎 Ревью'] },
    pos: { review: 0 },
    keys: { review: 'REVIEW' },
    statuses: { review: 'done' },
    nodeMeta: { review: {} },
    progress: { done: 1, total: 1, current: null },
    loops: {},
  };
  globalThis.__uiContextPipelineApi = {
    async get(url) {
      if (url === '/api/tasks') return { tasks: [factoryTask] };
      if (url === '/api/tasks/101/graph') return graph;
      if (url === '/api/factory/runners') return { runners: [] };
      if (url === '/api/tasks/101/doc/review') return { text: '' };
      return {};
    },
    async post() { return {}; },
  };
  globalThis.__uiContextTaskApi = {
    async get(url) {
      if (url.endsWith('/clarifications')) return { text: '' };
      if (url === '/api/tasks') return { tasks: [] };
      return {};
    },
    async post() { return {}; },
    async upload() { return {}; },
  };
  globalThis.__uiContextPipelineWait = await import('../../web/src/shared/pipeline-wait.js');
  globalThis.__uiContextRunnerDisplay = await import('../../web/src/shared/runner-display.js');
  globalThis.__uiContextFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="factory-graph-runtime"></div>',
  };

  const PipelineView = await compilePipelinePublisher();
  pipelineWrapper = mount(PipelineView, {
    attachTo: browser.document.querySelector('#pipeline-mount'),
    global: { plugins: [pinia] },
  });
  await flushPromises();
  pipelineWrapper.getComponent({ name: 'FactoryGraph' }).vm.$emit('node', {
    nid: 'review', label: '🔎 Ревью', status: 'done', sub: '',
  });
  await nextTick();
  await flushPromises();

  const uiContext = useUiContextStore();
  const route = { path: '/pipeline', meta: { title: 'Конвейер' } };
  assert.deepEqual(uiContext.capture(route).routingScope, { kind: 'task', taskId: '101' });
  assert.deepEqual(uiContext.capture(route).promptContext.details?.pipeline, {
    taskId: '101', stageId: 'review', tab: 'document', document: 'review',
  });

  const ui = globalThis.__uiContextUiStore();
  ui.taskId = '202';
  const TaskModal = await compileTaskModalPublisher();
  taskWrapper = mount(TaskModal, {
    attachTo: browser.document.querySelector('#task-mount'),
    global: { plugins: [pinia] },
  });
  await flushPromises();
  assert.deepEqual(
    uiContext.capture(route).routingScope,
    { kind: 'task', taskId: '202' },
    'открытая позже TaskModal выше stage overlay другой задачи',
  );
  assert.deepEqual(uiContext.capture(route).promptContext.details?.task, {
    taskId: '202', title: 'Задача 202',
  });

  taskWrapper.unmount();
  taskWrapper = null;
  await nextTick();
  assert.deepEqual(
    uiContext.capture(route).routingScope,
    { kind: 'task', taskId: '101' },
    'unmount TaskModal возвращает живой Pipeline scope',
  );

  taskWrapper = mount(TaskModal, {
    attachTo: browser.document.querySelector('#task-mount'),
    global: { plugins: [pinia] },
  });
  await flushPromises();
  pipelineWrapper.unmount();
  pipelineWrapper = null;
  await nextTick();
  assert.deepEqual(
    uiContext.capture(route).routingScope,
    { kind: 'task', taskId: '202' },
    'поздний unmount Pipeline не сносит живую TaskModal',
  );

  taskWrapper.unmount();
  taskWrapper = null;
  await nextTick();
  assert.equal(uiContext.capture(route).routingScope, null);
  assert.equal(uiContext.capture(route).promptContext.details, undefined);
});

test('COMP-PROV-12: реальный ToolHost не публикует hidden panel и dispose-ит owner', async (t) => {
  const browser = await browserHarness();
  const [
    { mount, flushPromises },
    { createPinia, defineStore, setActivePinia },
    { defineComponent, h, nextTick, onMounted, ref },
    { useUiContextStore },
    { useUiContextSource },
    dockModule,
  ] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/src/stores/ui-context.js'),
    import('../../web/src/composables/useUiContextSource.js'),
    import('../../web/src/stores/dock.js'),
  ]);
  const pinia = createPinia();
  setActivePinia(pinia);
  let wrapper = null;
  t.after(() => {
    if (wrapper?.exists()) wrapper.unmount();
    browser.close();
    for (const key of [
      '__uiContextToolRoute', '__uiContextDockModule', '__uiContextPluginsStore',
      '__uiContextSourceHelper', '__uiContextToolRegistry', '__uiContextDockCapable',
      '__uiContextToolDock',
    ]) delete globalThis[key];
  });

  const ContextPanel = defineComponent({
    name: 'ContextPanel',
    emits: ['context'],
    setup(_props, { emit }) {
      onMounted(() => emit('context', {
        project: 'alpha',
        repository: 'main',
        context: 'worktree',
        tab: 'file',
        file: 'src/app.js',
        line: 42,
        treePath: '/home/private/worktree',
        contents: 'secret source',
        token: 'secret token',
      }));
      return () => h('div', { class: 'context-panel' });
    },
  });
  const item = {
    id: 'code', label: 'Код', icon: 'code', route: '/code', component: ContextPanel,
  };
  globalThis.__uiContextToolRoute = { path: '/pipeline', meta: {} };
  globalThis.__uiContextDockModule = dockModule;
  globalThis.__uiContextPluginsStore = defineStore('ui-context-runtime-plugins', {
    state: () => ({ loaded: true, list: [] }),
    getters: { dockNav: () => [] },
  });
  globalThis.__uiContextSourceHelper = useUiContextSource;
  globalThis.__uiContextToolRegistry = {
    TOOL_REGISTRY: [item],
    TOOL_BY_ID: new Map([[item.id, item]]),
    toolAvailability: () => 'enabled',
  };
  globalThis.__uiContextDockCapable = ref(true);
  globalThis.__uiContextToolDock = {
    name: 'ToolDock',
    props: ['mode', 'label', 'width', 'minWidth', 'maxWidth', 'expanded', 'expandedWidth'],
    template: '<div class="tool-dock-runtime"><slot /></div>',
  };

  const dock = dockModule.useDockStore();
  dock.rememberTool('code');
  dock.setMounted('code', true);
  const ToolHost = await compileToolHostPublisher();
  wrapper = mount(ToolHost, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia] },
  });
  await flushPromises();

  const uiContext = useUiContextStore();
  const route = { path: '/pipeline', meta: { title: 'Конвейер' } };
  assert.equal(uiContext.capture(route).promptContext.details, undefined, 'hidden tool не публикует cache');

  dock.open('code');
  await nextTick();
  await flushPromises();
  assert.deepEqual(uiContext.capture(route).promptContext.details?.tool, {
    id: 'code',
    presentation: 'dock',
    project: 'alpha',
    repository: 'main',
    context: 'worktree',
    tab: 'file',
    file: 'src/app.js',
    line: 42,
  });
  assert.doesNotMatch(
    JSON.stringify(uiContext.capture(route).promptContext),
    /private|secret source|secret token|treePath|contents|token/i,
  );

  dock.close();
  await nextTick();
  assert.equal(uiContext.capture(route).promptContext.details, undefined, 'скрытие не оставляет stale details');

  dock.open('code');
  await nextTick();
  assert.ok(uiContext.capture(route).promptContext.details?.tool);
  wrapper.unmount();
  wrapper = null;
  await nextTick();
  assert.equal(uiContext.capture(route).promptContext.details, undefined, 'unmount удаляет active owner');
});

test('COMP-PROV-01..08: реальные страницы используют owner helper и bounded positive schemas', async () => {
  const files = Object.fromEntries(await Promise.all([
    ['routes', 'web/src/views/RoutesView.vue'],
    ['settings', 'web/src/views/SettingsView.vue'],
    ['tool', 'web/src/shared/layout/ToolHost.vue'],
    ['task', 'web/src/views/TaskModal.vue'],
    ['pipeline', 'web/src/views/PipelineView.vue'],
    ['agents', 'web/src/views/AgentsView.vue'],
    ['chats', 'web/src/views/ChatsView.vue'],
    ['projects', 'web/src/views/ProjectsView.vue'],
  ].map(async ([id, path]) => [id, await source(path)])));

  for (const [id, text] of Object.entries(files)) {
    assert.match(text, /useUiContextSource/, `${id}: owner helper не подключён`);
    assert.doesNotMatch(text, /useUiContextStore/, `${id}: legacy context store API остался`);
  }

  assert.match(files.pipeline, /function pipelineContextDetails/);
  assert.match(files.pipeline, /const details = \{ taskId:[^\n]*stageId:[^\n]*, tab \};/);
  assert.match(files.task, /function taskContextDetails/);
  assert.match(files.task, /routingScope:\s*\{ kind: 'task', taskId:/);
  assert.doesNotMatch(
    files.task.match(/function taskContextDetails[\s\S]*?\n\}/)?.[0] || '',
    /description|comment|telegram|portal|payload/i,
  );
  assert.match(files.agents, /details:\s*\{ agentId \}/);
  assert.match(files.chats, /details:\s*\{ chatId \}/);
  assert.doesNotMatch(files.chats, /details:\s*\{[^}]*messages|details:\s*\{[^}]*draft|details:\s*\{[^}]*sessionId/s);
  assert.match(files.projects, /edit\.value\?\.id/);
  assert.doesNotMatch(files.projects, /details:\s*\{[^}]*dir:/s);
});
