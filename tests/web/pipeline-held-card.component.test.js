// Карточка конвейера, созданного без старта: состояние «ожидает старта» вместо
// «стоит», главное действие «запустить» (тот же resume), а пока стенд поднимается
// (holdPending) — «создаётся» без кнопки старта. Обычная остановка не меняется.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePipelineView } from './helpers/pipeline-view.js';

process.env.NODE_ENV = 'test';

function graphOf() {
  return {
    route: 'feature',
    readOnly: false,
    fePort: null,
    sandbox: null,
    nodes: { build: [0, '🔧 Сборка'], gate_accept: [1, '🚦 Приёмка'] },
    pos: { build: 0, gate_accept: 1 },
    keys: { build: 'BUILD', gate_accept: 'GATE_ACCEPT' },
    statuses: { build: 'pending', gate_accept: 'pending' },
    nodeMeta: {},
    progress: { done: 0, total: 2, current: null },
  };
}

const HELD_TASK = {
  task: 8601,
  profile: 'alpha',
  daemonAlive: false,
  held: true,
  holdPending: false,
  attempt: 'a_0123456789abcdef0123456789abcdef',
  result: null,
  graph: graphOf(),
};

async function mountPipeline(t, { fixtures, post = async () => ({ ok: true }) } = {}) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/pipeline' });
  browser.happyDOM.setWindowSize({ width: 1024, height: 844 });

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
  browser.localStorage.setItem('grigdesk-compact', '1');
  browser.localStorage.setItem('grigdesk-pipeline-project', 'all');
  browser.localStorage.setItem('grigdesk-pipeline-status', 'all');
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const posts = [];
  globalThis.__pipelineHeldConfirmDialog = async () => true;
  globalThis.__pipelineHeldAlertDialog = async () => {};
  globalThis.__pipelineHeldApi = {
    async get(url) {
      url = url.replace(/\?sources=1$/u, '');

      if (url === '/api/tasks') {
        return {
          silenceWindow: 0,
          tasks: fixtures.map(({ graph, ...task }) => ({ readOnly: false, ...task })),
        };
      }

      const graphMatch = /^\/api\/tasks\/(\d+)\/graph$/.exec(url);
      if (graphMatch) {
        return fixtures.find((task) => String(task.task) === graphMatch[1]).graph;
      }

      return { runners: [] };
    },
    async post(url, body) {
      posts.push([url, body]);

      return post(url, body);
    },
  };
  globalThis.__pipelineHeldFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineHeldUiStore = defineStore('pipeline-held-ui', {
    actions: { openTask() {} },
  });
  globalThis.__pipelineHeldTasksStore = defineStore('pipeline-held-tasks', {
    actions: { async load() { return {}; }, title() { return 'Задача'; } },
  });
  globalThis.__pipelineHeldBoardStore = defineStore('pipeline-held-board', {
    state: () => ({ data: null }),
    actions: { async load() {} },
  });
  const wrapper = mount(await compilePipelineView('__pipelineHeld'), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__pipelineHeldApi', '__pipelineHeldConfirmDialog', '__pipelineHeldAlertDialog',
      '__pipelineHeldFactoryGraph', '__pipelineHeldUiStore', '__pipelineHeldTasksStore',
      '__pipelineHeldBoardStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  await flushPromises();
  browser.dispatchEvent(new browser.Event('resize'));

  return { wrapper, flushPromises, posts };
}

test('held-карточка показывает «ожидает старта» и запускает прогон кнопкой «запустить»', async (t) => {
  const { wrapper, flushPromises, posts } = await mountPipeline(t, { fixtures: [HELD_TASK] });

  assert.match(wrapper.get('.daemon').text(), /ожидает старта/u);
  const resume = wrapper.get('.sbresume');
  assert.match(resume.text(), /запустить/u);

  await resume.trigger('click');
  await flushPromises();
  assert.deepEqual(posts, [['/api/tasks/8601/resume', undefined]]);
});

test('holdPending-карточка показывает «создаётся» и не даёт старт до готовности стенда', async (t) => {
  const { wrapper, posts } = await mountPipeline(t, {
    fixtures: [{ ...HELD_TASK, held: false, holdPending: true }],
  });

  assert.match(wrapper.get('.daemon').text(), /создаётся/u);
  assert.equal(wrapper.findAll('.sbresume').length, 0);
  assert.equal(posts.length, 0);
});

test('обычная остановка сохраняет «продолжить прогон»: регресс прежнего гейта', async (t) => {
  const { wrapper } = await mountPipeline(t, {
    fixtures: [{ ...HELD_TASK, held: false, holdPending: false }],
  });

  assert.match(wrapper.get('.sbresume').text(), /продолжить прогон/u);
});
