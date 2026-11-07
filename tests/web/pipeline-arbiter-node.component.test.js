import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePipelineView } from './helpers/pipeline-view.js';

process.env.NODE_ENV = 'test';

// Плашка «арбитр разбирает» жила только в СВЁРНУТОЙ карточке, а развёрнутая показывает
// схему — и там задача во время разбора выглядела ровно как вставшая. Человек открывал
// узел с вопросом «что от меня хотят» и получал вердикт с кнопками, ни словом не
// упоминающими, что прямо сейчас этим занят арбитр.

function makeFixture({ arbitrating = null, status = 'stall' } = {}) {
  const factoryTask = {
    task: 42,
    profile: 'demo',
    route: 'consilium-debug',
    readOnly: false,
    daemonAlive: false,
    attempt: 'att-1',
    result: null,
    arbitrating,
    stall: {
      kind: 'human',
      stop: 'human',
      stage: 'BUILD',
      node: 'build',
      title: 'BUILD: узел вернул решение человеку',
      hint: 'открой узел и прочитай его замечание',
      arbitrable: true,
      arbiter: null,
    },
  };
  const graph = {
    daemonAlive: false,
    route: 'consilium-debug',
    readOnly: false,
    nodes: { build: ['agent', '🔧 Сборка'] },
    pos: { build: 0 },
    keys: { build: 'BUILD' },
    statuses: { build: status },
    nodeMeta: { build: {} },
    progress: { done: 0, total: 1, current: 'build' },
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

  globalThis.__pipelineArbNodeApi = {
    /**
     * Список задач отдаёт тот же opt-in источников, что запрашивает живой экран конвейера.
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

  globalThis.__pipelineArbNodeConfirmDialog = async () => true;
  globalThis.__pipelineArbNodeAlertDialog = async () => {};
  globalThis.__pipelineArbNodeFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn', 'arbitrating'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineArbNodeUiStore = defineStore('pipeline-arb-node-ui', {
    actions: { openTask() {} },
  });
  globalThis.__pipelineArbNodeTasksStore = defineStore('pipeline-arb-node-tasks', {
    actions: {
      async load() { return {}; },
      title() { return null; },
      async setStageRunner() { return { ok: true }; },
    },
  });
  globalThis.__pipelineArbNodeBoardStore = defineStore('pipeline-arb-node-board', {
    state: () => ({ data: null }),
    actions: { async load() {} },
  });
  const wrapper = mount(await compilePipelineView('__pipelineArbNode'), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__pipelineArbNodeApi', '__pipelineArbNodeConfirmDialog', '__pipelineArbNodeAlertDialog',
      '__pipelineArbNodeFactoryGraph', '__pipelineArbNodeUiStore', '__pipelineArbNodeTasksStore',
      '__pipelineArbNodeBoardStore',
    ]) delete globalThis[key];
  });
  await flushPromises();

  const openNode = async (status = 'stall') => {
    wrapper.findComponent(globalThis.__pipelineArbNodeFactoryGraph).vm.$emit('node', {
      id: 'build', label: '🔧 Сборка', subtitle: '', status,
    });
    await flushPromises();
  };
  return { wrapper, openNode };
}

test('идущий разбор передаётся в обсуждение своей вкладки арбитра', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({
    arbitrating: { actor: 'auto', model: 'claude/claude-opus-5', elapsedSec: 200 },
  }));
  await openNode();

  // Содержимое этапа — главная вкладка: пока она открыта, идущий разбор виден плашкой
  // над вкладками, а обсуждение смонтировано только на своей вкладке арбитра.
  assert.equal(wrapper.find('.sarbrun.sarbnode').exists(), true);
  assert.equal(wrapper.findComponent({ name: 'ArbiterConversation' }).exists(), false);

  await wrapper.get('#stage-arbiter-tab').trigger('click');

  const conversation = wrapper.getComponent({ name: 'ArbiterConversation' });

  assert.equal(wrapper.find('.sarbrun.sarbnode').exists(), false);
  assert.equal(conversation.props('arbitrating').model, 'claude/claude-opus-5');
  assert.match(conversation.get('.ac-status').text(), /На связи/);
  assert.equal(conversation.find('.ac-decisions').exists(), false);
  assert.match(wrapper.get('.sactions-context').text(), /Арбитр изучает остановку/);

  const badge = wrapper.find('.sbadge');

  assert.equal(badge.classes().includes('arb'), true, 'бейдж говорит тем же цветом, что узел');
  assert.equal(badge.text(), 'арбитр разбирает');

  await wrapper.get('#stage-activity-tab').trigger('click');
  assert.match(wrapper.get('.sarbrun.sarbnode').text(), /сам · 3 мин/);
});

test('без разбора модалка остаётся прежней', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture());
  await openNode();

  assert.equal(wrapper.find('.sarbrun.sarbnode').exists(), false);
  assert.equal(wrapper.find('.sbadge').classes().includes('arb'), false);
});

// Арбитр разбирает одну остановку. Плашка на пройденном узле обещала бы работу там,
// где её нет, и превращала бы признак в украшение.
test('плашка не появляется на узле без остановки', async (t) => {
  const fixture = makeFixture({
    arbitrating: { actor: 'auto', elapsedSec: 30 },
    status: 'done',
  });
  const { wrapper, openNode } = await mountPipeline(t, fixture);
  await openNode('done');

  assert.equal(wrapper.find('.sarbrun.sarbnode').exists(), false);
  assert.equal(wrapper.find('.sbadge').classes().includes('arb'), false);
});
