import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePipelineView } from './helpers/pipeline-view.js';

process.env.NODE_ENV = 'test';

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

// Стенд монтирует публичную модалку с настоящими дочерними компонентами.
// Ответы API управляют доступностью решения, а записи запросов проверяют его identity.
async function mountPipeline(t, {
  factoryTask,
  graph,
  postFails = null,
  findings = null,
  findingsFails = false,
}) {
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
  const getCalls = [];
  const posts = [];
  const alerts = [];

  globalThis.__pipelineGateApi = {
    /**
     * Список задач отвечает тем же opt-in источников, что запрашивает живой экран.
     * Граф, находки и каталог исполнителей принадлежат фикстуре этой проверки.
     */
    async get(url) {
      getCalls.push(url);

      if (url === '/api/tasks?sources=1') {
        return { tasks: [factoryTask] };
      }

      if (url === `/api/tasks/${factoryTask.task}/graph`) {
        return graph;
      }

      if (url === '/api/factory/runners') {
        return { runners: ['claude'] };
      }

      if (url.startsWith(`/api/tasks/${factoryTask.task}/findings?`)) {
        if (findingsFails) {
          throw new Error('Источник находок недоступен');
        }

        return {
          profile: factoryTask.profile,
          attemptId: factoryTask.attempt,
          findings: findings || { deferred: [] },
        };
      }

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
  globalThis.__pipelineGateConfirmDialog = async () => true;
  globalThis.__pipelineGateAlertDialog = async (text) => { alerts.push(text); };
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
  const wrapper = mount(await compilePipelineView('__pipelineGate'), {
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
      '__pipelineGateApi', '__pipelineGateConfirmDialog', '__pipelineGateAlertDialog',
      '__pipelineGateFactoryGraph', '__pipelineGateUiStore', '__pipelineGateTasksStore',
      '__pipelineGateBoardStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  const openStage = async (node) => {
    wrapper.findComponent(globalThis.__pipelineGateFactoryGraph).vm.$emit('node', node);
    await flushPromises();
  };
  const openGate = (status = 'wait') => openStage({
    id: 'gate_plan', label: '🚦 Ворота плана', subtitle: '', status,
  });
  const openPlan = (status = 'done') => openStage({
    id: 'plan', label: '📋 План', subtitle: '', status,
  });

  return {
    wrapper,
    flushPromises,
    getCalls,
    posts,
    alerts,
    openGate,
    openPlan,
    openStage,
  };
}

// Приёмка читает реальную findings-компоненту; ошибка должна удержать именно кнопку,
// успешно прочитанный пустой список разрешает тот же gate CAS с exact identity.
for (const findingsFails of [true, false]) {
  test(`приёмка: чтение находок ${findingsFails ? 'удерживает' : 'разрешает'} принятие`, async (t) => {
    const fx = makeFixture();

    fx.graph.nodes.gate_accept = ['human', 'Приёмка'];
    fx.graph.pos.gate_accept = 2;
    fx.graph.keys.gate_accept = 'GATE_ACCEPT';
    fx.graph.statuses.gate_accept = 'wait';
    fx.graph.nodeMeta.gate_accept = {};

    const { wrapper, openStage, posts, flushPromises } = await mountPipeline(t, { ...fx, findingsFails });

    await openStage({
      id: 'gate_accept',
      label: 'Приёмка',
      status: 'wait',
    });

    const button = wrapper.get('.gate-sect .btn.good');

    assert.equal(button.element.disabled, findingsFails);

    if (findingsFails) {
      assert.match(wrapper.text(), /Источник находок недоступен/);
      assert.equal(posts.length, 0);
    } else {
      await button.trigger('click');
      await flushPromises();
      assert.equal(posts[0][0], '/api/tasks/42/gate/GATE_ACCEPT/approve');
      assert.equal(posts[0][1].attempt, fx.factoryTask.attempt);
    }
  });
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
  assert.deepEqual(posts, [[
    '/api/tasks/42/gate/GATE_PLAN/approve',
    {
      comment: '',
      profile: 'demo',
      attempt: 'att-1',
    },
  ]]);
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
    {
      comment: 'Не учтён кейс с пустым списком',
      profile: 'demo',
      attempt: 'att-1',
    },
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
