import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePipelineView } from './helpers/pipeline-view.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

let serial = 0;

/**
 * Два конвейера имеют одинаковые ключи узлов и разные задачи, профили и попытки.
 * Задержанные ответы позволяют переключить окно до окончания сетевой операции.
 */
async function mountPipelines(t, { running = false } = {}) {
  const browser = await installUiBrowser(t);
  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const prefix = `__pipelineIsolation${serial += 1}`;
  const tasks = [42, 43].map((task) => ({
    task,
    profile: `project-${task}`,
    route: 'feature',
    attempt: `attempt-${task}`,
    daemonAlive: running,
    readOnly: false,
    result: null,
    stall: null,
  }));
  const graphs = tasks.map(() => ({
    daemonAlive: running,
    route: 'feature',
    readOnly: false,
    nodes: { browser: ['agent', 'Приёмка'], gate_plan: ['human', 'Ворота плана'] },
    pos: { browser: 0, gate_plan: 1 },
    keys: { browser: 'BROWSER', gate_plan: 'GATE_PLAN' },
    statuses: { browser: running ? 'run' : 'stall', gate_plan: 'wait' },
    nodeMeta: {
      browser: {
        runner: {
          primary: 'claude',
          actual: running ? 'claude' : null,
          chain: ['claude', 'codex'],
          attempts: [],
          source: 'profile-stage',
        },
      },
      gate_plan: {},
    },
    progress: {
      done: 0,
      total: 2,
      current: 'browser',
    },
  }));
  const reads = new Map();
  const writes = new Map();
  const posts = [];
  const alerts = [];
  const api = {
    /**
     * Читает синтетические снимки и удерживает только явно задержанные запросы.
     * Сеть и состояние настоящих конвейеров в проверке не используются.
     */
    async get(url) {
      if (reads.has(url)) {
        return reads.get(url).promise;
      }
      if (url === '/api/tasks?sources=1') {
        return { tasks };
      }
      if (url === '/api/factory/runners') {
        return { runners: ['claude', 'codex'] };
      }

      const index = tasks.findIndex((task) => url === `/api/tasks/${task.task}/graph`);

      return index < 0 ? {} : graphs[index];
    },
    async post(url, body) {
      posts.push({ url, body });

      return writes.has(url) ? writes.get(url).promise : { ok: true, resumed: true };
    },
  };

  globalThis[`${prefix}Api`] = api;
  globalThis[`${prefix}ConfirmDialog`] = async () => true;
  globalThis[`${prefix}AlertDialog`] = async (text) => {
    alerts.push(text);
  };

  const graphComponent = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };

  globalThis[`${prefix}FactoryGraph`] = graphComponent;
  globalThis[`${prefix}UiStore`] = defineStore(`${prefix}-ui`, { actions: { openTask() {} } });
  globalThis[`${prefix}TasksStore`] = defineStore(`${prefix}-tasks`, {
    actions: {
      async load() {
        return {};
      },
      title() {
        return null;
      },
      async setStageRunner(task, stage, primary) {
        return api.post(`/api/tasks/${task}/runner`, { stage, primary });
      },
    },
  });
  globalThis[`${prefix}BoardStore`] = defineStore(`${prefix}-board`, {
    state: () => ({ data: null }),
    actions: { async load() {} },
  });

  const component = await compilePipelineView(prefix, {
    expose: ['closeStage', 'stage', 'stageBusy', 'stageDoc', 'stageDocLoading', 'stageActivity', 'load'],
  });
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });

  t.after(() => {
    wrapper.unmount();

    for (const key of Object.keys(globalThis).filter((key) => key.startsWith(prefix))) {
      delete globalThis[key];
    }
  });
  await flushPromises();

  return {
    wrapper,
    flushPromises,
    prefix,
    tasks,
    graphs,
    reads,
    writes,
    posts,
    alerts,
    /**
     * Закрывает прежнее окно и открывает узел публичным событием нужного графа.
     * Все ожидающие ответы при этом продолжают принадлежать прежним запросам.
     */
    async open(index, id = 'browser') {
      wrapper.vm.closeStage();
      await flushPromises();
      wrapper.findAllComponents(graphComponent)[index].vm.$emit('node', {
        id,
        label: id === 'browser' ? 'Приёмка' : 'Ворота плана',
        status: graphs[index].statuses[id],
      });
      await flushPromises();
    },
  };
}

/**
 * Проверяет параллельные возвраты с одним и тем же ключом узла в разных конвейерах.
 * Завершение первого запроса не закрывает второе окно и не снимает его загрузку.
 */
async function checkConcurrentRewinds(t, rejectFirst) {
  const fx = await mountPipelines(t);
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();

  fx.writes.set('/api/tasks/42/stage/BROWSER/running', first);
  fx.writes.set('/api/tasks/43/stage/BROWSER/running', second);
  await fx.open(0);
  await fx.wrapper.get('.rewind-sect .play').trigger('click');
  await fx.flushPromises();
  assert.equal(fx.wrapper.get('.rewind-sect .play').element.disabled, true);

  await fx.open(1);
  assert.equal(fx.wrapper.vm.stage.task, 43);
  assert.equal(fx.wrapper.get('.rewind-sect .play').element.disabled, false);
  await fx.wrapper.get('.rewind-sect .play').trigger('click');
  await fx.flushPromises();
  await fx.open(0);
  assert.equal(fx.wrapper.get('.rewind-sect .play').element.disabled, true);
  await fx.open(1);

  if (rejectFirst) {
    first.reject(new Error('Первый возврат отклонён'));
  } else {
    first.resolve({ ok: true, resumed: true });
  }

  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stage?.task, 43);
  assert.equal(fx.wrapper.get('.rewind-sect .play').element.disabled, true);
  second.resolve({ ok: true, resumed: true });
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stage?.task, 43);
  assert.equal(fx.wrapper.get('.rewind-sect .play').element.disabled, false);
  await fx.open(0);
  assert.equal(fx.wrapper.get('.rewind-sect .play').element.disabled, false);
  assert.equal(fx.posts.length, 2);
}

for (const rejectFirst of [false, true]) {
  test(`возвраты изолированы: первый запрос ${rejectFirst ? 'отклонён' : 'успешен'}`, async (t) => {
    await checkConcurrentRewinds(t, rejectFirst);
  });
}

test('ответ ворот прежнего конвейера не закрывает окно другого узла', async (t) => {
  const fx = await mountPipelines(t);
  const pending = Promise.withResolvers();

  fx.writes.set('/api/tasks/42/gate/GATE_PLAN/approve', pending);
  await fx.open(0, 'gate_plan');
  await fx.wrapper.get('.gate-sect .good').trigger('click');
  await fx.flushPromises();
  await fx.open(1, 'gate_plan');
  assert.equal(fx.wrapper.get('.gate-sect .good').element.disabled, false);
  pending.resolve({ ok: true, resumed: true });
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stage?.task, 43);
  assert.deepEqual(fx.posts[0].body, {
    comment: '',
    profile: 'project-42',
    attempt: 'attempt-42',
  });
});

test('запоздалое подтверждение не отправляет возврат в уже другой конвейер', async (t) => {
  const fx = await mountPipelines(t);
  const confirmation = Promise.withResolvers();

  globalThis[`${fx.prefix}ConfirmDialog`] = () => confirmation.promise;
  await fx.open(0);
  await fx.wrapper.get('.rewind-sect .play').trigger('click');
  await fx.open(1);
  confirmation.resolve(true);
  await fx.flushPromises();
  assert.equal(fx.posts.length, 0);
  assert.equal(fx.wrapper.vm.stage?.task, 43);
});

test('документ и его загрузка не переходят из прежнего окна в новое', async (t) => {
  const fx = await mountPipelines(t);
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();

  fx.reads.set('/api/tasks/42/doc/report', first);
  fx.reads.set('/api/tasks/43/doc/report', second);
  await fx.open(0);
  await fx.open(1);
  first.resolve({ text: 'Документ первого конвейера' });
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stageDoc, '');
  assert.equal(fx.wrapper.vm.stageDocLoading, true);
  second.resolve({ text: 'Документ второго конвейера' });
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stageDoc, 'Документ второго конвейера');
  assert.equal(fx.wrapper.vm.stageDocLoading, false);
});

test('старый ответ активности не попадает в окно другого конвейера', async (t) => {
  const fx = await mountPipelines(t, { running: true });
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();

  fx.reads.set('/api/tasks/42/activity', first);
  fx.reads.set('/api/tasks/43/activity', second);
  await fx.open(0);
  await fx.open(1);
  first.resolve({ journalFresh: true, tail: [] });
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stageActivity, null);
  second.resolve({ journalFresh: false, tail: [] });
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stageActivity?.journalFresh, false);
});

test('завершение выбора исполнителя не сбрасывает выбор другого конвейера', async (t) => {
  const fx = await mountPipelines(t);
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();

  fx.writes.set('/api/tasks/42/runner', first);
  fx.writes.set('/api/tasks/43/runner', second);

  for (const index of [0, 1]) {
    await fx.open(index);
    await fx.wrapper.get('#stage-executors-tab').trigger('click');

    const picks = fx.wrapper.findAll('.executor-row .ui-selectable-row__primary');

    assert.equal(picks[1].element.disabled, false);
    await picks[1].trigger('click');
    await fx.flushPromises();
  }

  first.resolve({ ok: true });
  await fx.flushPromises();

  const selected = fx.wrapper.findAll('.executor-row .ui-selectable-row__primary')[1];

  assert.equal(selected.attributes('aria-pressed'), 'true');
  assert.equal(fx.wrapper.findAll('.executor-row')[1].attributes('aria-busy'), 'true');
  assert.equal(selected.element.disabled, true);
  second.resolve({ ok: true });
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stageBusy, null);
});

test('занятый узел блокирует повтор и соседние действия только своей попытки', async (t) => {
  const fx = await mountPipelines(t);
  const pending = Promise.withResolvers();

  fx.writes.set('/api/tasks/42/stage/BROWSER/running', pending);
  await fx.open(0);
  await fx.wrapper.get('.rewind-sect .play').trigger('click');
  await fx.flushPromises();
  await fx.wrapper.get('.rewind-sect .play').trigger('click');
  await fx.wrapper.get('#stage-executors-tab').trigger('click');
  assert.equal(fx.wrapper.get('.executor-row .ui-selectable-row__primary').element.disabled, true);
  assert.equal(fx.posts.length, 1);

  fx.tasks[0].attempt = 'next-attempt';
  await fx.wrapper.vm.load();
  await fx.open(0);
  assert.equal(fx.wrapper.get('.rewind-sect .play').element.disabled, false);
  pending.resolve({ ok: true, resumed: true });
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stage?.attempt, 'next-attempt');
});
