import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const VIEW_PATH = fileURLToPath(new URL('../../web/src/views/PipelineView.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;

// Тот же приём, что и в остальных тестах страницы конвейера: SFC компилируется с
// inline-шаблоном, а импорты подменяются заглушками через globalThis.
async function compilePipelineView() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: 'data-v-pipeline-gate-decision-test',
    inlineTemplate: true,
  }).content;
  code = code
    .replaceAll('from "vue"', 'from "' + VUE_URL + '"')
    .replaceAll("from 'vue'", "from '" + VUE_URL + "'")
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = globalThis.__pipelineGateApi;',
    )
    .replace(
      "import { useSse } from '../composables/useSse.js';",
      'const useSse = () => {};',
    )
    .replace(
      "import { useUiContextSource } from '../composables/useUiContextSource.js';",
      'const useUiContextSource = () => ({ focus() {}, update() {}, blur() {} });',
    )
    .replace(
      "import { useUiStore } from '../stores/ui.js';",
      'const useUiStore = globalThis.__pipelineGateUiStore;',
    )
    .replace(
      "import { useTasksStore } from '../stores/tasks.js';",
      'const useTasksStore = globalThis.__pipelineGateTasksStore;',
    )
    .replace(
      "import { useBoardStore } from '../stores/board.js';",
      'const useBoardStore = globalThis.__pipelineGateBoardStore;',
    )
    .replace(
      "import { useCompanionStore } from '../stores/companion.js';",
      'const useCompanionStore = globalThis.__pipelineGateCompanionStore;',
    )
    .replace(
      "import { liveTimerSec, pipelineWorkSec, secToHMS } from '../shared/format.js';",
      'const liveTimerSec = () => 0; const pipelineWorkSec = () => null; const secToHMS = (n) => String(n ?? 0);',
    )
    .replace(
      "import { mdToHtml } from '../shared/md.js';",
      'const mdToHtml = (value) => String(value || "");',
    )
    .replace(
      "import { confirmDialog, alertDialog } from '../shared/ui/confirm.js';",
      'const confirmDialog = globalThis.__pipelineGateConfirm;'
      + ' const alertDialog = globalThis.__pipelineGateAlert;',
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
      'const { waitingReason, stripEmoji } = globalThis.__pipelineGateWait;',
    )
    .replace(
      /import \{[^}]*\} from '\.\.\/shared\/runner-display\.js';/,
      'const { attemptCostLabel, attemptCostTitle, attemptResultLabel, providerLabel,'
      + ' runnerAttemptModelLabel, runnerChainLabel,'
      + ' runnerModelEffortLabel, runnerNodeLabel, runnerReasonLabel }'
      + ' = globalThis.__pipelineGateDisplay;',
    )
    .replace(
      "import FactoryGraph from './pipeline/FactoryGraph.vue';",
      'const FactoryGraph = globalThis.__pipelineGateFactoryGraph;',
    )
    .replace(
      "import OpenDiffButton from './OpenDiffButton.vue';",
      'const OpenDiffButton = { props: ["taskId"], template: "<span></span>" };',
    );
  compilePipelineView.seq = (compilePipelineView.seq || 0) + 1;
  return (await import(
    'data:text/javascript;base64,'
    + Buffer.from(`${code}\n// compile #${compilePipelineView.seq}`).toString('base64')
  )).default;
}

// Задача №42 на маршруте feature: план пройден, ворота плана ждут решения человека.
function makeFixture({ gateStatus = 'wait', gateComment = null, readOnly = false } = {}) {
  const factoryTask = {
    task: 42, profile: 'demo', route: 'feature', readOnly,
    daemonAlive: true, attempt: 'att-1', result: null, stall: null,
  };
  const graph = {
    daemonAlive: true, route: 'feature', readOnly,
    nodes: { plan: ['agent', '📋 План'], gate_plan: ['human', '🚦 Ворота плана'] },
    pos: { plan: 0, gate_plan: 1 },
    keys: { plan: 'PLAN', gate_plan: 'GATE_PLAN' },
    statuses: { plan: 'done', gate_plan: gateStatus },
    nodeMeta: { plan: {}, gate_plan: { comment: gateComment } },
    progress: { done: 1, total: 2, current: 'gate_plan' },
  };
  return { factoryTask, graph };
}

async function mountPipeline(t, { factoryTask, graph, postFails = null }) {
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
  const posts = [];
  const alerts = [];
  globalThis.__pipelineGateApi = {
    async get(url) {
      getCalls.push(url);
      if (url === '/api/tasks') return { tasks: [factoryTask] };
      if (url === `/api/tasks/${factoryTask.task}/graph`) return graph;
      if (url === '/api/factory/runners') return { runners: ['claude'] };
      return {};
    },
    async post(url, body) {
      posts.push([url, body]);
      if (postFails) {
        const err = new Error(postFails.message);
        err.status = postFails.status || 409;
        err.data = { error: postFails.error };
        throw err;
      }
      return { ok: true, resumed: true };
    },
  };
  globalThis.__pipelineGateConfirm = async () => true;
  globalThis.__pipelineGateAlert = async (text) => { alerts.push(text); };
  globalThis.__pipelineGateWait = await import('../../web/src/shared/pipeline-wait.js');
  globalThis.__pipelineGateDisplay = await import('../../web/src/shared/runner-display.js');
  globalThis.__pipelineGateFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineGateUiStore = defineStore('pipeline-gate-ui', {
    actions: { openTask() {} },
  });
  globalThis.__pipelineGateTasksStore = defineStore('pipeline-gate-tasks', {
    actions: {
      async load() { return {}; },
      title() { return null; },
      async setStageRunner() { return { ok: true }; },
    },
  });
  globalThis.__pipelineGateBoardStore = defineStore('pipeline-gate-board', {
    state: () => ({ data: null }),
    actions: { async load() {} },
  });
  globalThis.__pipelineGateCompanionStore = defineStore('pipeline-gate-companion', {
    actions: { openForTask() {} },
  });

  const wrapper = mount(await compilePipelineView(), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()] },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__pipelineGateApi', '__pipelineGateConfirm', '__pipelineGateAlert',
      '__pipelineGateWait', '__pipelineGateDisplay', '__pipelineGateFactoryGraph',
      '__pipelineGateUiStore', '__pipelineGateTasksStore', '__pipelineGateBoardStore',
      '__pipelineGateCompanionStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  const openStage = async (node) => {
    wrapper.findComponent(globalThis.__pipelineGateFactoryGraph).vm.$emit('node', node);
    await flushPromises();
  };
  const openGate = (status = 'wait') => openStage({
    nid: 'gate_plan', label: '🚦 Ворота плана', sub: '', status,
  });
  const openPlan = (status = 'done') => openStage({
    nid: 'plan', label: '📋 План', sub: '', status,
  });
  return { wrapper, flushPromises, getCalls, posts, alerts, openGate, openPlan };
}

test('ворота ждут решения: поля комментария нет, пока не нажали «Отклонить»', async (t) => {
  const { wrapper, openGate } = await mountPipeline(t, makeFixture());
  await openGate();

  const gate = wrapper.get('.gate-sect');
  // Поле, бесполезное при принятии, больше не висит над кнопками.
  assert.equal(gate.find('textarea').exists(), false);
  assert.deepEqual(
    gate.findAll('.gbtns .btn').map((b) => b.text()),
    ['✓ Принять', '✗ Отклонить'],
  );
});

test('«Принять» уходит без комментария и не спрашивает текст', async (t) => {
  const { wrapper, posts, flushPromises, openGate } = await mountPipeline(t, makeFixture());
  await openGate();

  await wrapper.get('.gate-sect .btn.good').trigger('click');
  await flushPromises();
  assert.deepEqual(posts, [['/api/tasks/42/gate/GATE_PLAN/approve', { comment: '' }]]);
  // Решение принято — модалка закрывается.
  assert.equal(wrapper.find('.smodal').exists(), false);
});

test('«Отклонить» раскрывает поле, и текст уезжает решением reject', async (t) => {
  const { wrapper, posts, flushPromises, openGate } = await mountPipeline(t, makeFixture());
  await openGate();

  await wrapper.get('.gate-sect .btn.bad').trigger('click');
  const note = wrapper.get('#gate-note');
  // Пока текст набирают, решение никуда не уходит.
  assert.deepEqual(posts, []);
  assert.match(wrapper.get('.gate-sect').text(), /заданием агенту/);

  await note.setValue('Не учтён кейс с пустым списком');
  await wrapper.get('.gate-sect .btn.bad').trigger('click');
  await flushPromises();
  assert.deepEqual(posts, [[
    '/api/tasks/42/gate/GATE_PLAN/reject',
    { comment: 'Не учтён кейс с пустым списком' },
  ]]);
});

test('«Отмена» возвращает кнопки решения и стирает набранное', async (t) => {
  const { wrapper, posts, openGate } = await mountPipeline(t, makeFixture());
  await openGate();

  await wrapper.get('.gate-sect .btn.bad').trigger('click');
  await wrapper.get('#gate-note').setValue('черновик');
  await wrapper.findAll('.gate-sect .gbtns .btn')[1].trigger('click');
  assert.equal(wrapper.find('#gate-note').exists(), false);

  // Повторное «Отклонить» открывает пустое поле, а не прошлый черновик.
  await wrapper.get('.gate-sect .btn.bad').trigger('click');
  assert.equal(wrapper.get('#gate-note').element.value, '');
  assert.deepEqual(posts, []);
});

test('движку некому доставить пояснение — человек видит, что делать', async (t) => {
  const { wrapper, alerts, flushPromises, openGate } = await mountPipeline(t, {
    ...makeFixture(),
    postFails: {
      error: 'gate_rejected',
      message: 'комментарий rejected нельзя доставить: rewind ведёт в ship (executor=code), нужен agent',
    },
  });
  await openGate();

  await wrapper.get('.gate-sect .btn.bad').trigger('click');
  await wrapper.get('#gate-note').setValue('переделать');
  await wrapper.get('.gate-sect .btn.bad').trigger('click');
  await flushPromises();

  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /нельзя доставить/);
  assert.match(alerts[0], /Отклони без текста/);
  // Модалка и набранный текст остались: решение не принято, его надо переиграть.
  assert.equal(wrapper.get('#gate-note').element.value, 'переделать');
});

test('принятые ворота: комментарий подписан честно — агенту он не уходил', async (t) => {
  const { wrapper, openGate } = await mountPipeline(
    t, makeFixture({ gateStatus: 'done', gateComment: 'ок, но следи за индексами' }),
  );
  await openGate('done');

  assert.equal(wrapper.find('.gate-sect').exists(), false);
  const comment = wrapper.get('.scomment');
  assert.match(comment.text(), /агенту он не уходил/);
  assert.match(comment.text(), /следи за индексами/);
});

test('отклонённые ворота: тот же ключ реестра подписан как отправленное на доработку', async (t) => {
  const { wrapper, openGate } = await mountPipeline(
    t, makeFixture({ gateStatus: 'stall', gateComment: 'нет плана отката' }),
  );
  await openGate('stall');

  assert.match(wrapper.get('.scomment').text(), /Отправлено агенту на доработку/);
});

test('обычный узел: указание живёт рядом с «Перейти сюда» и уезжает возвратом', async (t) => {
  const { wrapper, posts, flushPromises, openPlan } = await mountPipeline(t, makeFixture());
  await openPlan();

  // В ряду с чатом и диффом поля больше нет — оно в своей секции возврата.
  assert.equal(wrapper.find('.sactions textarea').exists(), false);
  const rewind = wrapper.get('.rewind-sect');
  assert.match(rewind.text(), /Вернуть конвейер сюда/);

  await rewind.get('textarea').setValue('перепиши план под новый API');
  await rewind.get('.btn.play').trigger('click');
  await flushPromises();
  assert.deepEqual(posts, [[
    '/api/tasks/42/stage/PLAN/running',
    { comment: 'перепиши план под новый API' },
  ]]);
});

test('ворота: секции возврата нет — решение принимают кнопками ворот', async (t) => {
  const { wrapper, openGate } = await mountPipeline(t, makeFixture());
  await openGate();

  assert.equal(wrapper.find('.rewind-sect').exists(), false);
});

test('read-only попытка: ни решения ворот, ни возврата', async (t) => {
  const { wrapper, openGate } = await mountPipeline(t, makeFixture({ readOnly: true }));
  await openGate();

  assert.equal(wrapper.find('.gate-sect').exists(), false);
  assert.equal(wrapper.find('.rewind-sect').exists(), false);
});
