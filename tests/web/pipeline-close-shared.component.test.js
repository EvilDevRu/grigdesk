// Выполненный прогон обязан иметь чем уйти с экрана.
//
// Кокпит не архивирует задачу сам: реестр в архив переносит человек кнопкой. У задачи
// со СВОЕЙ песочницей это «снести стенд», у задачи без стенда — «закрыть задачу». А у
// shared-профиля (общий checkout, внешний стенд) не показывалась ни та, ни другая:
// сносить чужой стенд кокпиту запрещено, а условие «закрыть» требовало отсутствия порта
// фронта — в shared-режиме порт есть всегда. Доведённый до конца прогон висел на экране
// навсегда. Тест держит кнопку на месте для всех трёх случаев.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePipelineView } from './helpers/pipeline-view.js';

process.env.NODE_ENV = 'test';

// Доведённая до конца задача: все узлы пройдены, демона нет, попытка терминальна.
function makeFixture({ workspaceMode = 'shared', fePort = 13000, sandbox = null } = {}) {
  const factoryTask = {
    task: 90002,
    profile: 'project-alpha',
    route: 'feature',
    readOnly: false,
    workspaceMode,
    daemonAlive: false,
    attempt: 'a_0ec48def',
    result: 'completed',
    stall: null,
  };
  const graph = {
    route: 'feature',
    readOnly: false,
    fePort,
    sandbox,
    nodes: { build: [0, '🔨 Реализация'], retro: [1, '🧾 Ретро'] },
    pos: { build: 0, retro: 1 },
    keys: { build: 'BUILD', retro: 'RETRO' },
    statuses: { build: 'done', retro: 'done' },
    nodeMeta: {},
    progress: { done: 2, total: 2, current: null },
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
  const posts = [];
  const companionCalls = [];
  globalThis.__pipelineCloseDialogs = [];
  globalThis.__pipelineCloseConfirmDialog = async (text) => {
    globalThis.__pipelineCloseDialogs.push(text);

    return true;
  };
  globalThis.__pipelineCloseAlertDialog = async (text) => {
    globalThis.__pipelineCloseDialogs.push(text);
  };
  globalThis.__pipelineCloseApi = {
    async get(url) {
      if (url === '/api/tasks') return { tasks: [factoryTask] };
      if (url === `/api/tasks/${factoryTask.task}/graph`) return graph;
      if (url === '/api/factory/runners') return { runners: [] };
      return {};
    },
    async post(url) { posts.push(url); return { ok: true, archived: ['pipeline'], branches: [] }; },
  };
  globalThis.__pipelineCloseFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineCloseUiStore = defineStore('pipeline-close-ui', { actions: { openTask() {} } });
  globalThis.__pipelineCloseTasksStore = defineStore('pipeline-close-tasks', {
    actions: { async load() { return {}; }, title() { return 'Динамические прокси'; } },
  });
  globalThis.__pipelineCloseBoardStore = defineStore('pipeline-close-board', {
    state: () => ({ data: null }), actions: { async load() {} },
  });
  globalThis.__pipelineCloseCompanionStore = defineStore('pipeline-close-companion', {
    actions: { openForTask(taskId) { companionCalls.push(String(taskId)); } },
  });

  const wrapper = mount(await compilePipelineView('__pipelineClose'), {
    attachTo: browser.document.querySelector('#mount'),
    global: {
      plugins: [createPinia()],
      stubs: { teleport: true },
    },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__pipelineCloseApi', '__pipelineCloseDialogs', '__pipelineCloseConfirmDialog',
      '__pipelineCloseAlertDialog', '__pipelineCloseFactoryGraph', '__pipelineCloseUiStore',
      '__pipelineCloseTasksStore', '__pipelineCloseBoardStore',
      '__pipelineCloseCompanionStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  return {
    wrapper,
    flushPromises,
    posts,
    companionCalls,
    dialogs: globalThis.__pipelineCloseDialogs,
  };
}

test('COMP-SHELL-Pipeline: обсуждение открывает companion с exact task и закрывает stage', async (t) => {
  const { wrapper, flushPromises, companionCalls } = await mountPipeline(t, makeFixture());
  wrapper.getComponent({ name: 'FactoryGraph' }).vm.$emit('node', {
    id: 'retro', label: '🧾 Ретро', status: 'done', subtitle: '',
  });
  await flushPromises();

  const discuss = wrapper.findAll('.sactions-buttons .btn').find((button) => /Обсудить с агентом/.test(button.text()));
  assert.ok(discuss);
  await discuss.trigger('click');
  await flushPromises();

  assert.deepEqual(companionCalls, ['90002']);
  assert.equal(wrapper.find('.smodal').exists(), false);
});

test('shared-задача с внешним стендом: «закрыть задачу» есть, «снести стенд» — нет', async (t) => {
  const { wrapper, flushPromises, posts, dialogs } = await mountPipeline(t, makeFixture());

  const close = wrapper.get('.sbclose');
  assert.match(close.text(), /закрыть задачу/);
  assert.equal(wrapper.findAll('.sbdown').filter((b) => /снести стенд/.test(b.text())).length, 0);

  await close.trigger('click');
  await flushPromises();
  assert.deepEqual(posts, ['/api/tasks/90002/close']);
  // Общий checkout кокпит не трогает — обещать удаление веток нельзя.
  assert.ok(dialogs.some((text) => /Общий checkout и его ветки не затрагиваются/.test(text)));
});

test('своя песочница: закрытие по-прежнему идёт через снос стенда', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({ workspaceMode: 'isolated' }));

  assert.equal(wrapper.find('.sbclose').exists(), false);
  assert.ok(wrapper.findAll('.sbdown').some((b) => /снести стенд/.test(b.text())));
});

test('стенда нет вовсе: кнопка закрытия остаётся и обещает удалить пустую ветку', async (t) => {
  const { wrapper, flushPromises, dialogs } = await mountPipeline(
    t, makeFixture({ workspaceMode: 'isolated', fePort: null }),
  );

  const close = wrapper.get('.sbclose');
  await close.trigger('click');
  await flushPromises();
  assert.ok(dialogs.some((text) => /Пустая ветка будет удалена/.test(text)));
});

test('стенд ещё строится: закрывать нечего — кнопки нет', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({
    fePort: null, sandbox: { step: 3, total: 9, label: 'миграции' },
  }));

  assert.equal(wrapper.find('.sbclose').exists(), false);
});
