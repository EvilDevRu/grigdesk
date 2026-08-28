import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePipelineView } from './helpers/pipeline-view.js';

process.env.NODE_ENV = 'test';

// До 28.08.2026 модалка узла показывала только однострочный дайджест `<КЛЮЧ>_COMMENT`
// из провайдерской проекции, а типизированные находки и класс владельца оставались в
// журнале попытки. Из-за этого остановка «узел вернул решение человеку» выглядела как
// пустая карточка: человек шёл читать `stage-results/` руками либо пересказывать вопрос
// агенту в чате, то есть работал курьером между двумя частями своей же системы.

function makeFixture({ verdict = null, comment = null, status = 'stall', readOnly = false } = {}) {
  const factoryTask = {
    task: 42, profile: 'demo', route: 'consilium-debug', readOnly,
    daemonAlive: false, attempt: 'att-1', result: null, stall: null,
  };
  const graph = {
    daemonAlive: false, route: 'consilium-debug', readOnly,
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
  globalThis.__pipelineVerdictApi = {
    async get(url) {
      if (url === '/api/tasks') return { tasks: [factoryTask] };
      if (url === `/api/tasks/${factoryTask.task}/graph`) return graph;
      if (url === '/api/factory/runners') return { runners: ['claude'] };
      return {};
    },
    async post() { return { ok: true }; },
  };
  globalThis.__pipelineVerdictConfirmDialog = async () => true;
  globalThis.__pipelineVerdictAlertDialog = async () => {};
  globalThis.__pipelineVerdictFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineVerdictUiStore = defineStore('pipeline-verdict-ui', {
    actions: { openTask() {} },
  });
  globalThis.__pipelineVerdictTasksStore = defineStore('pipeline-verdict-tasks', {
    actions: {
      async load() { return {}; },
      title() { return null; },
      async setStageRunner() { return { ok: true }; },
    },
  });
  globalThis.__pipelineVerdictBoardStore = defineStore('pipeline-verdict-board', {
    state: () => ({ data: null }),
    actions: { async load() {} },
  });
  globalThis.__pipelineVerdictCompanionStore = defineStore('pipeline-verdict-companion', {
    actions: { openForTask() {} },
  });

  const wrapper = mount(await compilePipelineView('__pipelineVerdict'), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__pipelineVerdictApi', '__pipelineVerdictConfirmDialog', '__pipelineVerdictAlertDialog',
      '__pipelineVerdictFactoryGraph', '__pipelineVerdictUiStore', '__pipelineVerdictTasksStore',
      '__pipelineVerdictBoardStore', '__pipelineVerdictCompanionStore',
    ]) delete globalThis[key];
  });
  await flushPromises();

  const openNode = async (status = 'stall') => {
    wrapper.findComponent(globalThis.__pipelineVerdictFactoryGraph).vm.$emit('node', {
      id: 'skeptic', label: '🔬 Скептик', subtitle: '', status,
    });
    await flushPromises();
  };
  return { wrapper, openNode };
}

const verdictOf = (extra = {}) => ({
  owner: 'human',
  reviewed: ['src/a.ts'],
  omitted: 0,
  outcome: 'failed',
  stop: null,
  rewind: null,
  findings: [
    {
      id: 'lever-empty',
      anchor: 'src/views/checking/useProxyScroll.ts',
      severity: 'blocking',
      summary: 'рычаг измерен и пуст: отставание 45 в 0.3 px',
    },
    { id: 'cosmetic', anchor: null, severity: 'deferred', summary: 'подпись оси не выровнена' },
  ],
  ...extra,
});

test('находки узла показаны списком, а не одной строкой комментария', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({
    verdict: verdictOf(),
    comment: 'редакция 2 не выдержала',
    readOnly: true,
  }));
  await openNode();

  const items = wrapper.findAll('.sverdict .svlist li');
  assert.equal(items.length, 2);
  assert.equal(items[0].text().includes('рычаг измерен и пуст'), true);
  // Однострочный дайджест остаётся на месте: он короче и отвечает на другой вопрос.
  assert.equal(wrapper.find('.snotices .scomment').text().includes('редакция 2'), true);
});

// Блокирующая находка — это вопрос к человеку, и у него ровно одно место: поле ответа
// в форме возврата. Пока список показывал её вторым экземпляром, замер модалки давал
// один и тот же абзац дважды на одном экране: наверху как находку, внизу как заголовок
// поля. Отложенная в списке остаётся — полей под неё нет по замыслу.
test('блокирующая находка не дублируется списком, когда рядом стоит форма ответа', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({ verdict: verdictOf() }));
  await openNode();

  const items = wrapper.findAll('.sverdict .svlist li');
  assert.equal(items.length, 1);
  assert.equal(items[0].classes().includes('deferred'), true);

  const questions = wrapper.findAll('.rwq .rwqsum');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].text().includes('рычаг измерен и пуст'), true);
});

// Остановка на человеке — единственный случай, когда блок сам является вызовом, поэтому
// заголовок обязан называть именно её, а не общее «замечания».
test('остановка на человеке названа в заголовке блока', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({
    verdict: verdictOf({ stop: 'human' }), readOnly: true,
  }));
  await openNode();

  assert.equal(wrapper.get('.sverdict .sclbl').text(), 'Узел вернул решение человеку');
  assert.equal(wrapper.get('.sverdict').classes().includes('human'), true);
});

test('возврат маршрута назван вместе с узлом, куда он ведёт', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({
    verdict: verdictOf({ rewind: 'chairman' }), readOnly: true,
  }));
  await openNode();

  assert.equal(wrapper.get('.sverdict .sclbl').text().includes('chairman'), true);
  assert.equal(wrapper.get('.sverdict').classes().includes('human'), false);
});

// Пять пунктов одинакового веса читаются как пять срочных дел; отложенное обязано уступать.
test('отложенная находка помечена отдельно от блокирующей', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({
    verdict: verdictOf(), readOnly: true,
  }));
  await openNode();

  const items = wrapper.findAll('.sverdict .svlist li');
  assert.equal(items[0].classes().includes('blocking'), true);
  assert.equal(items[1].classes().includes('deferred'), true);
});

// Путь целиком съедает строку и обрезается с конца, то есть теряет как раз имя файла.
test('якорь показывает имя файла, полный путь остаётся в подсказке', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({
    verdict: verdictOf(), readOnly: true,
  }));
  await openNode();

  const anchor = wrapper.get('.sverdict .svanchor');
  assert.equal(anchor.text(), 'useProxyScroll.ts');
  assert.equal(anchor.attributes('title'), 'src/views/checking/useProxyScroll.ts');
});

// Якорь уехал в форму вместе с самой находкой: без него человек знает, ЧТО не так,
// но не знает где, а второго списка находок на экране больше нет.
test('вопрос в форме возврата несёт якорь своей находки', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({ verdict: verdictOf() }));
  await openNode();

  const anchor = wrapper.get('.rwq .svanchor');
  assert.equal(anchor.text(), 'useProxyScroll.ts');
  assert.equal(anchor.attributes('title'), 'src/views/checking/useProxyScroll.ts');
});

test('без вердикта блок не рисуется вовсе', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({ comment: 'просто замечание' }));
  await openNode();

  assert.equal(wrapper.find('.sverdict').exists(), false);
  assert.equal(wrapper.find('.snotices .scomment').exists(), true);
});

test('вердикт без находок блок не рисует', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({
    verdict: verdictOf({ findings: [] }),
  }));
  await openNode();

  assert.equal(wrapper.find('.sverdict').exists(), false);
});

test('отброшенные по лимиту находки названы числом', async (t) => {
  const { wrapper, openNode } = await mountPipeline(t, makeFixture({
    verdict: verdictOf({ omitted: 6 }), readOnly: true,
  }));
  await openNode();

  assert.equal(wrapper.get('.sverdict .svmore').text().includes('6'), true);
});
