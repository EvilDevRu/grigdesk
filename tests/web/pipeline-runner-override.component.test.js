import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const VIEW_PATH = fileURLToPath(new URL('../../web/src/views/PipelineView.vue', import.meta.url));
const TASKS_STORE_PATH = fileURLToPath(new URL('../../web/src/stores/tasks.js', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;

async function compilePipelineView() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: 'data-v-pipeline-runner-override-test',
    inlineTemplate: true,
  }).content;
  code = code
    .replaceAll('from "vue"', 'from "' + VUE_URL + '"')
    .replaceAll("from 'vue'", "from '" + VUE_URL + "'")
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = globalThis.__pipelineRunnerApi;',
    )
    .replace(
      "import { useSse } from '../composables/useSse.js';",
      'const useSse = () => {};',
    )
    .replace(
      "import { useUiStore } from '../stores/ui.js';",
      'const useUiStore = globalThis.__pipelineRunnerUiStore;',
    )
    .replace(
      "import { useTasksStore } from '../stores/tasks.js';",
      'const useTasksStore = globalThis.__pipelineRunnerTasksStore;',
    )
    .replace(
      "import { useBoardStore } from '../stores/board.js';",
      'const useBoardStore = globalThis.__pipelineRunnerBoardStore;',
    )
    .replace(
      "import { useChatStore } from '../stores/chat.js';",
      'const useChatStore = globalThis.__pipelineRunnerChatStore;',
    )
    .replace(
      "import { liveTimerSec, pipelineWorkSec, secToHMS } from '../shared/format.js';",
      'const liveTimerSec = () => 0; const pipelineWorkSec = (tm) => tm?.workSec ?? null; const secToHMS = (n) => String(n ?? 0);',
    )
    .replace(
      "import { mdToHtml } from '../shared/md.js';",
      'const mdToHtml = (value) => String(value || "");',
    )
    .replace(
      "import { confirmDialog, alertDialog } from '../shared/ui/confirm.js';",
      'const confirmDialog = async () => true; const alertDialog = async () => {};',
    )
    .replace(
      "import { sandboxUrl } from '../shared/sandbox.js';",
      'const sandboxUrl = (port) => "http://sandbox.test:" + port;',
    )
    .replace(
      "import { agentActivityLabel } from '../shared/agent-activity.js';",
      'const agentActivityLabel = () => "";',
    )
    .replace(
      "import { waitingReason, stripEmoji } from '../shared/pipeline-wait.js';",
      'const { waitingReason, stripEmoji } = globalThis.__pipelineRunnerWait;',
    )
    .replace(
      /import \{[^}]*\} from '\.\.\/shared\/runner-display\.js';/,
      'const { attemptResultLabel, providerLabel, runnerChainLabel, runnerModelLabel, runnerNodeLabel, runnerReasonLabel }'
      + ' = globalThis.__pipelineRunnerDisplay;',
    )
    .replace(
      "import FactoryGraph from './pipeline/FactoryGraph.vue';",
      'const FactoryGraph = globalThis.__pipelineRunnerFactoryGraph;',
    )
    .replace(
      "import OpenDiffButton from './OpenDiffButton.vue';",
      'const OpenDiffButton = { props: ["taskId"], template: "<span></span>" };',
    );
  // Уникальный хвост: одинаковый data: URL отдал бы кеш модуля с заглушками чужого теста.
  compilePipelineView.seq = (compilePipelineView.seq || 0) + 1;
  return (await import(
    'data:text/javascript;base64,'
    + Buffer.from(`${code}\n// compile #${compilePipelineView.seq}`).toString('base64')
  )).default;
}

// Задача №42 на маршруте feature: два узла, у plan — runner-мета с заданным источником.
function makeFixture({ status = 'wait', source = 'profile-stage', readOnly = false, actual = null } = {}) {
  const factoryTask = {
    task: 42,
    profile: 'arsenkin',
    route: 'feature',
    readOnly,
    daemonAlive: true,
    attempt: null,
    result: null,
    stall: null,
  };
  const graph = {
    route: 'feature',
    readOnly,
    nodes: { plan: [0, '📋 План'], gate_plan: [1, '🚦 Ворота плана'] },
    pos: { plan: 0, gate_plan: 1 },
    keys: { plan: 'PLAN', gate_plan: 'GATE_PLAN' },
    statuses: { plan: status, gate_plan: 'pending' },
    nodeMeta: {
      plan: {
        runner: {
          primary: 'claude',
          failover: ['codex'],
          chain: ['claude', 'codex'],
          source,
          actual,
          model: null,
          reason: null,
          switched: false,
        },
      },
    },
    progress: { done: 0, total: 2, current: 'plan' },
  };
  return { factoryTask, graph };
}

// Стенд страницы конвейера: happy-dom + заглушки сторов, api — перехватчик.
async function mountPipeline(t, { factoryTask, graph, runners = ['claude', 'codex'] }) {
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

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const getCalls = [];
  const runnerCalls = [];
  globalThis.__pipelineRunnerApi = {
    async get(url) {
      getCalls.push(url);
      if (url === '/api/tasks') return { tasks: [factoryTask] };
      if (url === `/api/tasks/${factoryTask.task}/graph`) return graph;
      if (url === '/api/factory/runners') return { runners };
      if (url.includes('/instruction')) return { text: '' };
      return {};
    },
    async post() { return { ok: true }; },
  };
  globalThis.__pipelineRunnerWait = await import('../../web/src/shared/pipeline-wait.js');
  globalThis.__pipelineRunnerDisplay = await import('../../web/src/shared/runner-display.js');
  globalThis.__pipelineRunnerFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineRunnerUiStore = defineStore('pipeline-runner-ui', {
    actions: { openTask() {} },
  });
  globalThis.__pipelineRunnerTasksStore = defineStore('pipeline-runner-tasks', {
    actions: {
      async load() { return {}; },
      title() { return null; },
      async setStageRunner(id, stage, primary) {
        runnerCalls.push([id, stage, primary]);
        return { ok: true };
      },
    },
  });
  globalThis.__pipelineRunnerBoardStore = defineStore('pipeline-runner-board', {
    state: () => ({ data: null }),
    actions: { async load() {} },
  });
  globalThis.__pipelineRunnerChatStore = defineStore('pipeline-runner-chat', {
    actions: { openFor() {} },
  });

  const wrapper = mount(await compilePipelineView(), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()] },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__pipelineRunnerApi',
      '__pipelineRunnerWait',
      '__pipelineRunnerDisplay',
      '__pipelineRunnerFactoryGraph',
      '__pipelineRunnerUiStore',
      '__pipelineRunnerTasksStore',
      '__pipelineRunnerBoardStore',
      '__pipelineRunnerChatStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  // Клик по узлу графа: стаб FactoryGraph просто эмитит то, что сказали.
  const openStage = async (node) => {
    wrapper.findComponent(globalThis.__pipelineRunnerFactoryGraph).vm.$emit('node', node);
    await flushPromises();
  };
  const openPlanStage = (status) => openStage({ nid: 'plan', label: '📋 План', sub: '', status });
  return { wrapper, flushPromises, getCalls, runnerCalls, openStage, openPlanStage };
}

test('небегущий этап: блок выбора исполнителя с текущим значением и источником, выбор шлёт override', async (t) => {
  const { wrapper, getCalls, runnerCalls, openPlanStage } = await mountPipeline(t, makeFixture());
  await openPlanStage('wait');

  const block = wrapper.get('.runner-override');
  assert.match(block.text(), /Исполнитель этапа/);
  // Текущее эффективное значение — runner.primary, источник виден рядом (RUNNER_SOURCE).
  const select = wrapper.get('#stage-runner');
  assert.equal(select.element.value, 'claude');
  assert.deepEqual(
    select.findAll('option').map((option) => option.text()),
    ['Claude', 'Codex'],
  );
  assert.match(wrapper.get('.runner-sect').text(), /политика этапа/);
  // Список исполнителей приехал из /api/factory/runners.
  assert.ok(getCalls.includes('/api/factory/runners'));

  await select.setValue('codex');
  assert.deepEqual(runnerCalls, [[42, 'PLAN', 'codex']]);
});

test('источник task-stage: видна «Сбросить» с честной подписью, клик шлёт пустой primary', async (t) => {
  const { wrapper, runnerCalls, openPlanStage } = await mountPipeline(
    t, makeFixture({ source: 'task-stage' }),
  );
  await openPlanStage('idle');

  const reset = wrapper.get('.runner-reset');
  assert.match(reset.text(), /Сбросить/);
  // Подпись обязана говорить, к чему вернётся этап: к override задачи или к профилю.
  assert.match(wrapper.get('.runner-override').text(), /запуске задачи|профил/);

  await reset.trigger('click');
  assert.deepEqual(runnerCalls, [[42, 'PLAN', '']]);
});

test('источник не task-stage: кнопки «Сбросить» нет', async (t) => {
  const { wrapper, openPlanStage } = await mountPipeline(t, makeFixture({ source: 'task' }));
  await openPlanStage('wait');

  assert.ok(wrapper.get('.runner-override').exists());
  assert.equal(wrapper.find('.runner-reset').exists(), false);
});

test('этап в run: блока выбора нет, остаются только switch-кнопки', async (t) => {
  const { wrapper, openPlanStage } = await mountPipeline(t, makeFixture({ status: 'run', actual: 'claude' }));
  await openPlanStage('run');

  assert.equal(wrapper.find('.runner-override').exists(), false);
  const switches = wrapper.get('.runner-switches');
  assert.match(switches.text(), /Переключить сейчас на Codex/);
});

test('readOnly: блока выбора исполнителя нет', async (t) => {
  const { wrapper, openPlanStage } = await mountPipeline(t, makeFixture({ readOnly: true }));
  await openPlanStage('wait');

  assert.ok(wrapper.get('.runner-sect').exists());
  assert.equal(wrapper.find('.runner-override').exists(), false);
});

// Сам store-action — отдельно и по-настоящему: URL и тело запроса.
test('tasks.setStageRunner шлёт POST /api/tasks/:id/runner/override (пустой primary — снятие)', async () => {
  globalThis.__pipelineRunnerStoreApi = {
    posts: [],
    async post(url, body) { this.posts.push([url, body]); return { ok: true }; },
  };
  let code = await readFile(TASKS_STORE_PATH, 'utf8');
  code = code
    .replace("import { defineStore } from 'pinia';", `import { defineStore } from "${PINIA_URL}";`)
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = globalThis.__pipelineRunnerStoreApi;',
    )
    .replace(
      "import { useBoardStore } from './board.js';",
      'const useBoardStore = () => ({ load: async () => {} });',
    );
  const [{ createPinia, setActivePinia }, { useTasksStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')),
  ]);
  setActivePinia(createPinia());
  const store = useTasksStore();

  await store.setStageRunner(42, 'PLAN', 'codex');
  await store.setStageRunner(42, 'PLAN', '');
  assert.deepEqual(globalThis.__pipelineRunnerStoreApi.posts, [
    ['/api/tasks/42/runner/override', { stage: 'PLAN', primary: 'codex' }],
    ['/api/tasks/42/runner/override', { stage: 'PLAN', primary: '' }],
  ]);
  delete globalThis.__pipelineRunnerStoreApi;
});
