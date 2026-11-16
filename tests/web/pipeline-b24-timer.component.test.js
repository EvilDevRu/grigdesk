import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePipelineView } from './helpers/pipeline-view.js';

process.env.NODE_ENV = 'test';

const START_MS = 1_800_000_000_000;

function factoryTask(task, title) {
  return {
    task,
    title,
    profile: 'demo',
    route: 'feature',
    readOnly: false,
    workspaceMode: 'shared',
    daemonAlive: false,
    attempt: 'att-1',
    result: null,
    stall: null,
  };
}

function graph(timing = null) {
  return {
    daemonAlive: false,
    route: 'feature',
    readOnly: false,
    nodes: { build: ['agent', 'Реализация'] },
    pos: { build: 0 },
    keys: { build: 'BUILD' },
    statuses: { build: 'done' },
    nodeMeta: { build: {} },
    progress: { done: 1, total: 1, current: null },
    timing,
  };
}

function cardByTask(wrapper, task) {
  return wrapper.findAll('.card').find((card) => (
    card.get('[data-role="pipeline-task-id"]').text() === `#${task}`
  ));
}

function timerSnapshot(card) {
  const timer = card?.find('[data-role="pipeline-tracker-timer"]');

  if (!timer?.exists()) {
    return {
      exists: false,
      state: undefined,
      text: undefined,
      title: undefined,
      tag: undefined,
    };
  }

  return {
    exists: true,
    state: timer.attributes('data-state'),
    text: timer.text(),
    title: timer.attributes('data-ui-tooltip'),
    tag: timer.element.tagName,
  };
}

/**
 * Страница получает три фабричные карточки и один внешний таймер через те же store/API
 * границы, что и в приложении. Часы и единственный секундный interval управляются тестом.
 */
async function mountScenario(t, {
  external = false, boardTasksOverride = null, boardToReview = [], boardExtra = {},
} = {}) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/pipeline' });
  const browserGlobals = {
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
  };
  const previousGlobals = new Map();

  for (const [key, value] of Object.entries(browserGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const tasks = [
    factoryTask(101, 'Идущий B24-таймер'),
    factoryTask(202, 'Остановленный B24-таймер'),
    factoryTask(303, 'Ручной тикет'),
  ];

  if (external) {
    tasks.push({
      ...factoryTask('100000000001', 'Внешняя задача'),
      source: `fixture-a@${'a'.repeat(64)}`,
    });
  }

  const graphs = new Map([
    [101, graph({
      workSec: 60 * 60,
      gateWaitSec: 0,
      runningSinceMs: null,
      source: 'runner-telemetry',
    })],
    [202, graph()],
    [303, graph()],
    [100000000001, graph()],
  ]);
  const boardTasks = boardTasksOverride ?? [
    {
      id: '101',
      title: 'Идущий B24-таймер',
      timerRunning: true,
      timerStartedAt: START_MS / 1000 - 65,
      timerElapsed: 777,
    },
    {
      id: '202',
      title: 'Остановленный B24-таймер',
      timerRunning: false,
      timerStartedAt: 0,
      timerElapsed: 321,
    },
    {
      id: '404',
      title: 'Таймер вне фабрики',
      timerRunning: true,
      timerStartedAt: START_MS / 1000 - 7,
      timerElapsed: 999,
    },
  ];
  const getCalls = [];
  const loadedTasks = [];
  const openedTasks = [];
  let boardLoads = 0;

  globalThis.__pipelineB24Api = {
    /**
     * Полный список источников и адресные графы читаются из одного набора задач.
     * Неизвестная ручка не маскируется пустым успешным ответом.
     */
    async get(url) {
      getCalls.push(url);

      if (url === '/api/tasks?sources=1') {
        return { tasks };
      }

      const graphMatch = url.match(/^\/api\/tasks\/(\d+)\/graph$/u);

      if (graphMatch && graphs.has(Number(graphMatch[1]))) {
        return graphs.get(Number(graphMatch[1]));
      }

      throw new Error(`Неожиданный GET ${url}`);
    },
    async post() {
      throw new Error('POST в сценарии отображения таймера не ожидается');
    },
  };
  globalThis.__pipelineB24ConfirmDialog = async () => true;
  globalThis.__pipelineB24AlertDialog = () => {};
  globalThis.__pipelineB24ContextSource = () => ({
    focus() {},
    update() {},
    blur() {},
  });
  globalThis.__pipelineB24FactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineB24UiStore = defineStore('pipeline-b24-ui', {
    actions: { openTask(id) {
      openedTasks.push(String(id));
    } },
  });
  globalThis.__pipelineB24TasksStore = defineStore('pipeline-b24-tasks', {
    actions: {
      async load(id) {
        loadedTasks.push(String(id));
      },
      title(id) {
        return external && String(id) === '100000000001' ? 'Внешняя задача' : null;
      },
    },
  });
  globalThis.__pipelineB24BoardStore = defineStore('pipeline-b24-board', {
    state: () => ({ data: {
      ...boardExtra,
      tasks: boardTasks,
      toReview: boardToReview
    } }),
    actions: {
      async load() {
        boardLoads += 1;
      },
    },
  });
  const originalDateNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = [];
  const clearedIntervals = [];
  let nowMs = START_MS;

  Date.now = () => nowMs;
  globalThis.setInterval = (callback, delay) => {
    const handle = { callback, delay };
    intervals.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    clearedIntervals.push(handle);
  };

  const wrapper = mount(await compilePipelineView('__pipelineB24'), {
    attachTo: browser.document.querySelector('#mount'),
    global: {
      plugins: [createPinia()],
      stubs: { teleport: true },
    },
  });

  t.after(() => {
    wrapper.unmount();
    Date.now = originalDateNow;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    browser.close();

    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
    for (const key of [
      '__pipelineB24Api',
      '__pipelineB24ConfirmDialog',
      '__pipelineB24AlertDialog',
      '__pipelineB24ContextSource',
      '__pipelineB24FactoryGraph',
      '__pipelineB24UiStore',
      '__pipelineB24TasksStore',
      '__pipelineB24BoardStore',
    ]) {
      delete globalThis[key];
    }
  });

  await flushPromises();

  return {
    wrapper,
    flushPromises,
    getCalls,
    loadedTasks,
    openedTasks,
    intervals,
    clearedIntervals,
    boardLoads: () => boardLoads,
    advanceSecond() {
      nowMs += 1000;
      intervals[0]?.callback();
    },
  };
}

test('карточки конвейера различают три состояния B24-таймера и сохраняют границы', async (t) => {
  const scenario = await mountScenario(t);
  const { wrapper, flushPromises } = scenario;
  const runningCard = cardByTask(wrapper, 101);
  const stoppedCard = cardByTask(wrapper, 202);
  const manualCard = cardByTask(wrapper, 303);
  const initialRunning = timerSnapshot(runningCard);
  const initialStopped = timerSnapshot(stoppedCard);
  const initialManual = timerSnapshot(manualCard);
  const elapsed = runningCard?.find('.elapsed');

  scenario.advanceSecond();
  await flushPromises();
  const afterTick = timerSnapshot(runningCard);

  await runningCard?.get('.chev').trigger('click');
  await flushPromises();
  const afterCollapse = timerSnapshot(runningCard);
  // Кнопки, чей доступный текст — ДАННЫЕ задачи, сторожу не подходят: название придумывает
  // человек на портале, а подсказка фильтра состояний перечисляет задачи поимённо. Задача
  // «Остановить таймер» зажигала бы тревогу, которой на странице нет. Сторож обязан читать
  // машинную роль кнопки, а не текст, приехавший снаружи, — та же грабля, что с гейтом
  // арбитра по заголовку остановки.
  const dataDrivenRoles = new Set([
    'pipeline-title',
    'pipeline-project',
    'pipeline-project-overflow-option',
    'pipeline-status-filter',
  ]);
  const timerButtons = wrapper.findAll('button').filter((button) => {
    if (dataDrivenRoles.has(button.attributes('data-role'))) {
      return false;
    }

    const accessibleText = [
      button.text(),
      button.attributes('aria-label'),
      button.attributes('data-ui-tooltip'),
    ].filter(Boolean).join(' ');

    return /таймер/iu.test(accessibleText) && /запуст|пауз|останов/iu.test(accessibleText);
  });

  assert.deepEqual({
    initialRunning,
    initialStopped,
    initialManual,
    afterTick: afterTick.text,
    metricsTogether: {
      b24: initialRunning.text,
      pipeline: elapsed?.text(),
      b24HasStopwatch: initialRunning.text?.includes('⏱'),
      titlesDiffer: initialRunning.title !== elapsed?.attributes('data-ui-tooltip'),
    },
    afterCollapse: {
      collapsed: runningCard?.classes().includes('collapsed'),
      graphVisible: runningCard?.find('.gwrap').exists(),
      timer: afterCollapse,
    },
    timerButtonCount: timerButtons.length,
    outsideTaskIds: wrapper.findAll('.outside .orow .oid').map((row) => row.text()),
    intervalDelays: scenario.intervals.map((interval) => interval.delay),
    boardLoads: scenario.boardLoads(),
    getCalls: scenario.getCalls,
  }, {
    initialRunning: {
      exists: true,
      state: 'running',
      text: 'B24-таймер идёт · 0:01:05',
      title: 'Таймер Битрикс24 по этой задаче',
      tag: 'SPAN',
    },
    initialStopped: {
      exists: true,
      state: 'stopped',
      text: 'B24-таймер стоит',
      title: 'Таймер Битрикс24 по этой задаче',
      tag: 'SPAN',
    },
    initialManual: {
      exists: false,
      state: undefined,
      text: undefined,
      title: undefined,
      tag: undefined,
    },
    afterTick: 'B24-таймер идёт · 0:01:06',
    metricsTogether: {
      b24: 'B24-таймер идёт · 0:01:05',
      pipeline: '⏱ 1:00:00',
      b24HasStopwatch: false,
      titlesDiffer: true,
    },
    afterCollapse: {
      collapsed: true,
      graphVisible: false,
      timer: {
        exists: true,
        state: 'running',
        text: 'B24-таймер идёт · 0:01:06',
        title: 'Таймер Битрикс24 по этой задаче',
        tag: 'SPAN',
      },
    },
    timerButtonCount: 0,
    outsideTaskIds: ['#404'],
    intervalDelays: [1000],
    boardLoads: 1,
    getCalls: [
      '/api/tasks?sources=1',
      '/api/tasks/101/graph',
      '/api/tasks/202/graph',
      '/api/tasks/303/graph',
    ],
  });
});

test('EXTERNAL-PIPELINE-01: внешнее название открывает карточку с гидратацией трекера', async (t) => {
  const fx = await mountScenario(t, { external: true });
  const card = cardByTask(fx.wrapper, '100000000001');

  assert.ok(card, 'Внешняя задача видна в списке конвейера');
  assert.equal(fx.loadedTasks.includes('100000000001'), true);

  const title = card.find('[data-role="pipeline-title"]');

  assert.ok(title.exists(), 'Название внешней задачи доступно как действие');
  assert.equal(title.text(), 'Внешняя задача');
  await title.trigger('click');
  assert.deepEqual(fx.openedTasks, ['100000000001']);
  assert.equal(cardByTask(fx.wrapper, 303).find('[data-role="pipeline-title"]').exists(), false);

  // Управляем только отложенным чтением: существующий throttle проходит без реального ожидания.
  // Часы B24-таймера и интервалы сценария остаются под управлением общей фикстуры.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.__pipelineB24SseHandler('state-change', {});
  t.mock.timers.tick(1000);
  await fx.flushPromises();
  assert.equal(fx.loadedTasks.includes('100000000001'), true);
  assert.ok(fx.getCalls.filter((url) => url === '/api/tasks?sources=1').length >= 2);
});

test('таймер из контроля попадает в блок «вне фабрики»', async (t) => {
  const scenario = await mountScenario(t, {
    boardTasksOverride: [
      {
        id: '101',
        title: 'Идущий B24-таймер',
        timerRunning: false,
        timerStartedAt: START_MS / 1000 - 65,
        timerElapsed: 777
      },
    ],
    boardToReview: [
      {
        id: '404',
        title: 'Таймер вне фабрики из контроля',
        timerRunning: true,
        timerStartedAt: START_MS / 1000 - 7,
        timerElapsed: 999
      },
    ],
  });
  const { wrapper } = scenario;
  const outside = wrapper.findAll('.orow');

  assert.equal(outside.length, 1);
  assert.match(outside[0].text(), /Таймер вне фабрики из контроля/u);
});

test('таймер другой ветки виден при default без timer capability', async (t) => {
  const { wrapper } = await mountScenario(t, {
    boardTasksOverride: [],
    boardExtra: { multiSource: true, capabilities: { timer: false } },
    boardToReview: [{
      id: '404',
      title: 'Активная другая ветка',
      timerRunning: true
    }],
  });

  const outside = wrapper.findAll('.orow');

  assert.equal(outside.length, 1);
  assert.match(outside[0].text(), /Активная другая ветка/u);
});
