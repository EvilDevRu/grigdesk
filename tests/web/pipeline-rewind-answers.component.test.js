import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePipelineView } from './helpers/pipeline-view.js';

process.env.NODE_ENV = 'test';

// Узел возвращает вопросы СТРУКТУРНО: у каждой блокирующей находки свой id и своя
// формулировка. А ответить на них можно было только сплошным текстом в одном поле —
// человек руками восстанавливал нумерацию («1 - …, 2 - …»), а агент получал сплошняк
// вместо ответа, привязанного к его же вопросу. Форма закрывает именно этот разрыв.

function makeFixture({ verdict = null, comment = null, status = 'stall' } = {}) {
  const factoryTask = {
    task: 42, profile: 'demo', route: 'consilium-debug', readOnly: false,
    daemonAlive: false, attempt: 'att-1', result: null, stall: null,
  };
  const graph = {
    daemonAlive: false, route: 'consilium-debug', readOnly: false,
    nodes: { skeptic: ['agent', '🔬 Скептик'] },
    pos: { skeptic: 0 },
    keys: { skeptic: 'SKEPTIC' },
    statuses: { skeptic: status },
    nodeMeta: { skeptic: { comment, verdict } },
    progress: { done: 0, total: 1, current: 'skeptic' },
  };
  return { factoryTask, graph };
}

async function mountPipeline(t, { factoryTask, graph }) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/pipeline' });
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

  globalThis.__pipelineRewindApi = {
    /**
     * Список задач отвечает тем же opt-in источников, что запрашивает живой экран.
     * Граф и каталог исполнителей принадлежат фикстуре и не обращаются к живым задачам.
     */
    async get(url) {
      if (url === '/api/tasks?sources=1') {
        return { tasks: [factoryTask] };
      }

      if (url === `/api/tasks/${factoryTask.task}/graph`) {
        return graph;
      }

      if (url === '/api/factory/runners') {
        return { runners: ['claude'] };
      }

      return {};
    },
    async post() { return { ok: true }; },
  };
  globalThis.__pipelineRewindConfirmDialog = async () => true;
  globalThis.__pipelineRewindAlertDialog = async () => {};
  globalThis.__pipelineRewindFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineRewindUiStore = defineStore('pipeline-rewind-ui', {
    actions: { openTask() {} },
  });
  globalThis.__pipelineRewindTasksStore = defineStore('pipeline-rewind-tasks', {
    actions: {
      async load() { return {}; },
      title() { return null; },
      async setStageRunner() { return { ok: true }; },
    },
  });
  globalThis.__pipelineRewindBoardStore = defineStore('pipeline-rewind-board', {
    state: () => ({ data: null }),
    actions: { async load() {} },
  });
  const wrapper = mount(await compilePipelineView('__pipelineRewind'), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__pipelineRewindApi', '__pipelineRewindConfirmDialog', '__pipelineRewindAlertDialog',
      '__pipelineRewindFactoryGraph', '__pipelineRewindUiStore', '__pipelineRewindTasksStore',
      '__pipelineRewindBoardStore',
    ]) delete globalThis[key];
  });
  await flushPromises();

  const openNode = async (status = 'stall') => {
    wrapper.findComponent(globalThis.__pipelineRewindFactoryGraph).vm.$emit('node', {
      id: 'skeptic', label: '🔬 Скептик', subtitle: '', status,
    });
    await flushPromises();
  };
  return { wrapper, openNode };
}


const questions = [
  { id: 'scope-marker', anchor: null, severity: 'blocking', summary: 'входит ли метка периода в задачу' },
  { id: 'outside-boundary', anchor: null, severity: 'blocking', summary: 'обходить ли легенду' },
  { id: 'cosmetic', anchor: null, severity: 'deferred', summary: 'подпись оси не выровнена' },
];

const verdictOf = (findings = questions) => ({
  owner: 'human', reviewed: [], omitted: 0, outcome: 'failed',
  stop: 'human', rewind: null, findings,
});

test('поле ответа появляется у каждой блокирующей находки и только у неё', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({ verdict: verdictOf() }));
  await openNode();

  const items = wrapper.findAll('.rwq .rwqitem');
  assert.equal(items.length, 2, 'отложенная находка вопросом к человеку не является');
  assert.equal(items[0].text().includes('входит ли метка периода'), true);
  assert.equal(items[1].text().includes('обходить ли легенду'), true);
});

test('ответы уезжают привязанными к вопросам узла, а не сплошняком', async (t) => {
  const sent = [];
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({ verdict: verdictOf() }));
  globalThis.__pipelineRewindApi.post = async (url, body) => {
    sent.push({ url, body });
    return { ok: true, resumed: true };
  };
  await openNode();

  const fields = wrapper.findAll('.rwq .rwqitem textarea');
  await fields[0].setValue('нет, не входит');
  await fields[1].setValue('только поле графика');
  await wrapper.get('#rewind-free').setValue('остальное по задаче');
  await wrapper.get('.rewind-sect .play').trigger('click');
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(sent.length, 1);
  const note = sent[0].body.comment;
  assert.match(note, /^Ответы на вопросы узла:/);
  assert.match(note, /1\. входит ли метка периода в задачу\n   Ответ: нет, не входит/);
  assert.match(note, /2\. обходить ли легенду\n   Ответ: только поле графика/);
  assert.match(note, /остальное по задаче$/);
});

// Незаполненное поле означает «вопрос остаётся открытым», а не пустую строку в задании.
// Номер при этом СОХРАНЯЕТСЯ: он адресует вопрос узла, который человек видел в форме, а
// перенумерация уцелевших ответов сместила бы адресацию — агент решил бы, что ответили
// на первый вопрос, тогда как открытым остался именно он.
test('пустой ответ в указание не попадает, а номера не съезжают', async (t) => {
  const sent = [];
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({ verdict: verdictOf() }));
  globalThis.__pipelineRewindApi.post = async (url, body) => {
    sent.push(body); return { ok: true, resumed: true };
  };
  await openNode();

  await wrapper.findAll('.rwq .rwqitem textarea')[1].setValue('только поле графика');
  await wrapper.get('.rewind-sect .play').trigger('click');
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(sent[0].comment.includes('входит ли метка периода'), false);
  assert.match(sent[0].comment, /2\. обходить ли легенду/);
});

// Узел без вопросов обязан вести себя ровно как раньше: одно поле, текст как есть.
test('без блокирующих находок форма не появляется, а текст едет как есть', async (t) => {
  const sent = [];
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({
    verdict: verdictOf([questions[2]]),
  }));
  globalThis.__pipelineRewindApi.post = async (url, body) => {
    sent.push(body); return { ok: true, resumed: true };
  };
  await openNode();

  assert.equal(wrapper.find('.rwq').exists(), false);
  await wrapper.get('.rewind-sect textarea').setValue('просто указание');
  await wrapper.get('.rewind-sect .play').trigger('click');
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  assert.equal(sent[0].comment, 'просто указание');
});
