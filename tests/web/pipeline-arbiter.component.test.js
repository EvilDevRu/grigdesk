// Кнопка арбитра в плашке затыка.
//
// Арбитр — единственное действие кокпита, которое двигает курсор чужой задачи по решению
// модели. Поэтому здесь проверяется прежде всего ГЕЙТ: он обязан читать машинный вид
// остановки (`stall.stop`), а не заголовок. Заголовок пишется человеку и меняется вместе
// с формулировками движка; привяжи кнопку к нему — и она однажды появится над остановкой,
// решение для которой из вердиктов дуги не выводится вовсе.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePipelineView } from './helpers/pipeline-view.js';

process.env.NODE_ENV = 'test';

function makeFixture({ stall, result = null } = {}) {
  const factoryTask = {
    task: 42,
    profile: 'project-alpha',
    route: 'feature',
    readOnly: false,
    workspaceMode: 'isolated',
    daemonAlive: false,
    attempt: 'a_0ec48def',
    result,
    stall,
  };
  const graph = {
    route: 'feature',
    readOnly: false,
    fePort: null,
    sandbox: null,
    daemonAlive: false,
    nodes: { plan: [0, '📋 План'], skeptic: [1, '🕵 Скептик'] },
    pos: { plan: 0, skeptic: 1 },
    keys: { plan: 'PLAN', skeptic: 'SKEPTIC' },
    statuses: { plan: 'done', skeptic: 'fail' },
    nodeMeta: {},
    progress: { done: 1, total: 2, current: 'skeptic' },
  };
  return { factoryTask, graph };
}

const NO_PROGRESS_STALL = {
  kind: 'human',
  stop: 'no-progress',
  stage: 'SKEPTIC',
  title: 'SKEPTIC: замкнутый набор замечаний расширен новыми id: shared-module',
  hint: 'блокирующие замечания пережили ремонт',
  since: '17:55',
  comment: null,
};

async function mountPipeline(t, { factoryTask, graph }, { response } = {}) {
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
  // Плашка затыка живёт в СВЁРНУТОЙ карточке: развёрнутая показывает граф.
  browser.localStorage.setItem('cockpit-compact', '1');
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const posts = [];
  globalThis.__pipelineArbiterDialogs = [];
  globalThis.__pipelineArbiterConfirmDialog = async (text) => {
    globalThis.__pipelineArbiterDialogs.push(text);
    return true;
  };
  globalThis.__pipelineArbiterAlertDialog = async (text) => {
    globalThis.__pipelineArbiterDialogs.push(text);
  };
  globalThis.__pipelineArbiterApi = {
    async get(url) {
      if (url === '/api/tasks') return { tasks: [factoryTask] };
      if (url === `/api/tasks/${factoryTask.task}/graph`) return graph;
      if (url === '/api/factory/runners') return { runners: [] };
      return {};
    },
    async post(url) {
      posts.push(url);
      return response || { ok: true, resolved: true };
    },
  };
  globalThis.__pipelineArbiterFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineArbiterUiStore = defineStore('pipeline-arbiter-ui', { actions: { openTask() {} } });
  globalThis.__pipelineArbiterTasksStore = defineStore('pipeline-arbiter-tasks', {
    actions: { async load() { return {}; }, title() { return 'Задача'; } },
  });
  globalThis.__pipelineArbiterBoardStore = defineStore('pipeline-arbiter-board', {
    state: () => ({ data: null }), actions: { async load() {} },
  });
  globalThis.__pipelineArbiterCompanionStore = defineStore('pipeline-arbiter-companion', {
    actions: { openForTask() {} },
  });

  const wrapper = mount(await compilePipelineView('__pipelineArbiter'), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__pipelineArbiterApi', '__pipelineArbiterDialogs', '__pipelineArbiterConfirmDialog',
      '__pipelineArbiterAlertDialog', '__pipelineArbiterFactoryGraph', '__pipelineArbiterUiStore',
      '__pipelineArbiterTasksStore', '__pipelineArbiterBoardStore',
      '__pipelineArbiterCompanionStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  return {
    wrapper, flushPromises, posts, dialogs: globalThis.__pipelineArbiterDialogs,
  };
}

const arbiterButton = (wrapper) => wrapper.findAll('.stalled button')
  .find((button) => /разобрать и продолжить/.test(button.text()));

test('кнопка арбитра есть у остановки по отсутствию прогресса', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({ stall: NO_PROGRESS_STALL }));
  assert.ok(arbiterButton(wrapper), 'кнопка показана');
});

test('гейт читает машинный вид остановки, а не заголовок', async (t) => {
  // Исчерпанный лимит возвратов — та же дуга и почти тот же текст, но решение там
  // принимает человек: набор замечаний мог и не расширяться, круги просто кончились.
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: {
      ...NO_PROGRESS_STALL, stop: 'rewind-limit', title: 'SKEPTIC: исчерпан лимит возвратов',
    },
  }));
  assert.equal(arbiterButton(wrapper), undefined);
});

test('затык без машинного вида арбитру не отдаётся', async (t) => {
  // Упавший стенд, нехватка прав, оборванный демон: вердиктов дуги там нет вовсе,
  // и выводить решение не из чего.
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: {
      kind: 'human', stage: 'SANDBOX', title: 'стенд не поднялся', hint: 'смотри журнал', since: null,
    },
  }));
  assert.equal(arbiterButton(wrapper), undefined);
});

test('нажатие спрашивает подтверждение и зовёт арбитра', async (t) => {
  const { wrapper, flushPromises, posts, dialogs } = await mountPipeline(
    t,
    makeFixture({ stall: NO_PROGRESS_STALL }),
    {
      response: {
        ok: true,
        resolved: true,
        node: 'plan',
        card: {
          what: 'выбрал аудит вместо общего модуля',
          why: 'общий модуль ломает плоский каталог',
          proof: 'запустил импорт обеими формами',
          risk: 'замер покажет ноль дублей там, где их не считали',
        },
      },
    },
  );
  await arbiterButton(wrapper).trigger('click');
  await flushPromises();

  assert.deepEqual(posts, ['/api/tasks/42/arbitrate']);
  // Подтверждение обязано сказать, что решение уедет в журнал машинным: человек должен
  // понимать, что подписывает не своё суждение.
  assert.ok(dialogs.some((text) => /записано в журнал как машинное/.test(text)));
  assert.ok(dialogs.some((text) => /выбрал аудит вместо общего модуля/.test(text)));
  assert.ok(dialogs.some((text) => /Чем грозит ошибка/.test(text)));
});

test('решение о границе задачи возвращается человеку, а не выдаётся за отказ', async (t) => {
  const { wrapper, flushPromises, posts, dialogs } = await mountPipeline(
    t,
    makeFixture({ stall: NO_PROGRESS_STALL }),
    {
      response: {
        ok: true,
        resolved: false,
        verdict: 'human',
        scopeChange: true,
        card: {
          what: 'критерий 5 недоказуем на этих данных',
          why: 'в реестре эталонов нет дефектных чертежей',
          proof: 'прочитал реестр и прогон',
          risk: 'задача уедет без проверки на реальных данных',
        },
      },
    },
  );
  await arbiterButton(wrapper).trigger('click');
  await flushPromises();

  assert.deepEqual(posts, ['/api/tasks/42/arbitrate']);
  assert.ok(
    dialogs.some((text) => /Это решает человек/.test(text)),
    'исход показан как работа арбитра, а не как его поломка',
  );
  assert.ok(dialogs.some((text) => /критерий 5 недоказуем/.test(text)));
});
