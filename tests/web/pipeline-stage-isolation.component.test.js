import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePipelineView } from './helpers/pipeline-view.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { settingsButton, settingsFields, stageSettingsOptions } from './helpers/stage-runner-settings.js';

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
    attempt: `a_${String(task).padStart(32, '0')}`,
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
  const optionsRequests = [];
  const pendingOptions = new Map();
  const confirmedByTask = new Map(tasks.map((task) => [task.task, stageSettingsOptions({
    ...task,
    node: 'browser',
    stage: 'BROWSER',
    running,
  })]));
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
      if (url.includes('/runner/options')) {
        optionsRequests.push(url);

        const task = Number(url.match(/tasks\/(\d+)/)[1]);

        if (pendingOptions.has(task)) {
          return pendingOptions.get(task).promise;
        }

        const confirmed = confirmedByTask.get(task);
        const provider = new URL(url, 'http://fixture').searchParams.get('provider')
          || confirmed.selection.parametersFor;

        return provider === confirmed.selection.parametersFor ? confirmed : stageSettingsOptions({
          ...tasks.find((entry) => entry.task === task),
          node: 'browser',
          stage: 'BROWSER',
          provider,
          running,
        });
      }
      if (url === '/api/factory/runners') {
        return { runners: ['claude', 'codex'] };
      }

      const index = tasks.findIndex((task) => url === `/api/tasks/${task.task}/graph`);

      return index < 0 ? {} : graphs[index];
    },
    /**
     * Запоздалые ответы мутаций завершаются только по команде сценария.
     * Подтверждённая настройка затем читается тем же options, как после ответа настоящего API.
     */
    async post(url, body) {
      posts.push({ url, body });

      const task = Number(url.match(/tasks\/(\d+)/)?.[1]);
      const current = confirmedByTask.get(task);
      const selected = url.endsWith('/runner/settings') ? stageSettingsOptions({
        ...tasks.find((item) => item.task === task),
        node: 'browser',
        stage: 'BROWSER',
        provider: body.selection.parametersFor,
        running,
      }) : null;
      const result = writes.has(url) ? await writes.get(url).promise
        : url.endsWith('/runner/settings') ? {
          ...selected,
          actual: current.actual,
          selection: { ...body.selection },
          effective: {
            primary: body.selection.parametersFor,
            model: body.selection.model ?? selected.effective.model,
            effort: body.selection.effort ?? selected.effective.effort,
          },
          revision: current.revision + 1,
          receipt: { requestId: body.requestId, state: 'saved' },
        } : { ok: true, resumed: true };

      if (url.endsWith('/runner/settings') && result.selection) {
        confirmedByTask.set(task, result);
      }

      return result;
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
      async getStageRunnerOptions(task, query) {
        return api.get(`/api/tasks/${task}/runner/options?${new URLSearchParams(query)}`);
      },
      async applyStageRunnerSettings(task, payload) {
        return api.post(`/api/tasks/${task}/runner/settings`, payload);
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
    optionsRequests,
    pendingOptions,
    confirmedByTask,
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
    attempt: `a_${'42'.padStart(32, '0')}`,
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

  fx.writes.set('/api/tasks/42/runner/settings', first);
  fx.writes.set('/api/tasks/43/runner/settings', second);

  for (const index of [0, 1]) {
    await fx.open(index);
    await fx.wrapper.get('#stage-executors-tab').trigger('click');

    const picks = fx.wrapper.findAll('.executor-row .ui-selectable-row__primary');

    assert.equal(picks[1].element.disabled, false);
    await picks[1].trigger('click');
    await fx.flushPromises();
  }

  const confirmed = (index) => ({
    ...stageSettingsOptions({
      ...fx.tasks[index],
      node: 'browser',
      stage: 'BROWSER',
      provider: 'codex',
    }),
    selection: {
      primary: 'codex',
      parametersFor: 'codex',
      model: null,
      effort: null
    },
    revision: 1,
  });

  first.resolve(confirmed(0));
  await fx.flushPromises();

  const selected = fx.wrapper.findAll('.executor-row .ui-selectable-row__primary')[1];

  assert.equal(selected.attributes('aria-pressed'), 'true');
  assert.equal(fx.posts.filter((post) => post.url.endsWith('/runner/settings')).length, 2);
  assert.equal(selected.element.disabled, true);
  second.resolve(confirmed(1));
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stageBusy, null);
});

test('закрытие окна во время каталога не отменяет сохранение исполнителя', async (t) => {
  const fx = await mountPipelines(t);
  const metadata = Promise.withResolvers();

  await fx.open(0);
  await fx.wrapper.get('#stage-executors-tab').trigger('click');
  fx.pendingOptions.set(42, metadata);
  await fx.wrapper.findAll('.executor-row .ui-selectable-row__primary')[1].trigger('click');
  fx.wrapper.vm.closeStage();
  await fx.flushPromises();
  metadata.resolve(stageSettingsOptions({
    ...fx.tasks[0],
    node: 'browser',
    stage: 'BROWSER',
    provider: 'codex',
  }));
  await fx.flushPromises();

  const saves = fx.posts.filter((post) => post.url.endsWith('/runner/settings'));

  console.error('AGENT-DBG Сохранение после закрытия окна', { requests: saves.length });
  assert.equal(saves.length, 1);
  assert.equal(saves[0].body.selection.primary, 'codex');
  assert.equal(saves[0].body.identity.task, '42');
  assert.equal(fx.confirmedByTask.get(42).selection.primary, 'codex');
  assert.equal(fx.wrapper.vm.stage, null);
});

test('повторное открытие подхватывает сохранение во время каталога и POST', async (t) => {
  const fx = await mountPipelines(t);
  const metadata = Promise.withResolvers();
  const write = Promise.withResolvers();

  await fx.open(0);
  await fx.wrapper.get('#stage-executors-tab').trigger('click');
  fx.pendingOptions.set(42, metadata);
  fx.writes.set('/api/tasks/42/runner/settings', write);
  await fx.wrapper.findAll('.executor-row .ui-selectable-row__primary')[1].trigger('click');

  const reads = fx.optionsRequests.length;

  await fx.open(0);
  await fx.wrapper.get('#stage-executors-tab').trigger('click');
  assert.equal(fx.optionsRequests.length, reads, 'повторное открытие не дублирует discovery');
  assert.equal(fx.wrapper.vm.stageBusy, 'runner-options');
  assert.equal(fx.wrapper.findAll('.executor-row .ui-selectable-row__primary')[1]
    .attributes('aria-pressed'), 'true');

  const options = stageSettingsOptions({
    ...fx.tasks[0],
    node: 'browser',
    stage: 'BROWSER',
    provider: 'codex',
  });

  fx.pendingOptions.delete(42);
  metadata.resolve(options);
  await fx.flushPromises();
  await fx.open(0);
  await fx.wrapper.get('#stage-executors-tab').trigger('click');
  assert.equal(fx.wrapper.vm.stageBusy, 'runner-override');
  assert.equal(settingsFields(fx.wrapper)[0].element.disabled, true);

  const saves = fx.posts.filter((post) => post.url.endsWith('/runner/settings'));

  assert.equal(saves.length, 1);
  write.resolve({
    ...options,
    selection: saves[0].body.selection,
    revision: 1,
  });
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stageBusy, null);
  assert.equal(settingsFields(fx.wrapper)[0].element.disabled, false);
  assert.equal(fx.confirmedByTask.get(42).selection.primary, 'codex');
  assert.equal(fx.wrapper.vm.stage.task, 42);
});

test('сохранение после смены окна не меняет выбор другого этапа', async (t) => {
  const fx = await mountPipelines(t);
  const metadata = Promise.withResolvers();

  await fx.open(0);
  await fx.wrapper.get('#stage-executors-tab').trigger('click');
  fx.pendingOptions.set(42, metadata);
  await fx.wrapper.findAll('.executor-row .ui-selectable-row__primary')[1].trigger('click');
  await fx.open(1);
  await fx.wrapper.get('#stage-executors-tab').trigger('click');
  await settingsFields(fx.wrapper)[1].setValue('high');
  await fx.flushPromises();
  metadata.resolve(stageSettingsOptions({
    ...fx.tasks[0],
    node: 'browser',
    stage: 'BROWSER',
    provider: 'codex',
  }));
  await fx.flushPromises();
  assert.equal(fx.confirmedByTask.get(42).selection.primary, 'codex');
  assert.equal(fx.confirmedByTask.get(43).selection.effort, 'high');
  assert.equal(fx.wrapper.vm.stage.task, 43);
  assert.equal(settingsFields(fx.wrapper)[1].element.value, 'high');
  assert.equal(fx.wrapper.vm.stageBusy, null);
});

for (const phase of ['catalog', 'save', 'effort']) {
  test(`ошибка ${phase} после закрытия окна видна с исходной задачей`, async (t) => {
    const fx = await mountPipelines(t);
    const pending = Promise.withResolvers();

    await fx.open(0);
    await fx.wrapper.get('#stage-executors-tab').trigger('click');

    if (phase === 'catalog') {
      fx.pendingOptions.set(42, pending);
    } else {
      fx.writes.set('/api/tasks/42/runner/settings', pending);
    }

    if (phase === 'effort') {
      await settingsFields(fx.wrapper)[1].setValue('high');
    } else {
      await fx.wrapper.findAll('.executor-row .ui-selectable-row__primary')[1].trigger('click');
    }

    await fx.flushPromises();
    fx.wrapper.vm.closeStage();
    await fx.flushPromises();
    pending.reject(new Error('Временный отказ сохранения'));
    await fx.flushPromises();
    assert.equal(fx.alerts.length, 1);
    assert.match(fx.alerts[0], /Приёмка.*#42.*Временный отказ сохранения/);
    assert.equal(fx.wrapper.vm.stage, null);
    await fx.open(0);
    assert.equal(fx.wrapper.vm.stageBusy, null);
  });
}

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

  fx.tasks[0].attempt = `a_${'9'.repeat(32)}`;
  await fx.wrapper.vm.load();
  await fx.open(0);
  assert.equal(fx.wrapper.get('.rewind-sect .play').element.disabled, false);
  pending.resolve({ ok: true, resumed: true });
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stage?.attempt, `a_${'9'.repeat(32)}`);
});

// К6: оба await принадлежат прежнему opening, даже если stage ID совпадает.
test('late-options-and-confirmation-ignore-new-opening', async (t) => {
  const fx = await mountPipelines(t, { running: true });
  const pending = Promise.withResolvers();

  fx.pendingOptions.set(42, pending);
  await fx.open(0);
  await fx.wrapper.get('#stage-executors-tab').trigger('click');
  assert.ok(fx.optionsRequests.some((url) => url.includes('/tasks/42/runner/options')));
  await fx.open(1);
  await fx.wrapper.get('#stage-executors-tab').trigger('click');

  const foreign = stageSettingsOptions({
    task: 42,
    profile: 'project-42',
    attempt: fx.tasks[0].attempt,
    node: 'browser',
    stage: 'BROWSER',
  });

  foreign.models = [{
    id: 'foreign-model',
    label: 'Модель прежнего окна',
    efforts: ['high'],
    aliases: [],
  }];
  foreign.effective.model = 'foreign-model';
  foreign.effective.effort = 'high';
  pending.resolve(foreign);
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stage.task, 43);
  assert.equal(settingsFields(fx.wrapper)[0].findAll('option')
    .some((option) => option.element.value === 'foreign-model'), false);

  const confirmation = Promise.withResolvers();

  globalThis[`${fx.prefix}ConfirmDialog`] = () => confirmation.promise;
  await settingsButton(fx.wrapper, /Перезапустить с этими параметрами/).trigger('click');
  await fx.open(0);
  confirmation.resolve(true);
  await fx.flushPromises();
  assert.equal(fx.wrapper.vm.stage.task, 42);
  assert.equal(fx.posts.some((post) => post.url.endsWith('/runner/settings')), false);
});

test('dirty-draft-survives-refresh', async (t) => {
  const fx = await mountPipelines(t);

  await fx.open(0);
  await fx.wrapper.get('#stage-executors-tab').trigger('click');

  const fields = settingsFields(fx.wrapper);

  assert.equal(fields[0].element.disabled, false);
  await fields[0].setValue('opus-other');

  fx.graphs[0].nodeMeta.browser.runner.actual = 'claude';
  fx.graphs[0].nodeMeta.browser.runner.model = 'actual-after-refresh';
  await fx.wrapper.vm.load();
  await fx.flushPromises();
  assert.equal(settingsFields(fx.wrapper)[0].element.value, 'opus-other');
  assert.equal(settingsFields(fx.wrapper)[1].element.value, '\u0001inherit');
  assert.equal(fx.posts.some((post) => post.url.endsWith('/runner/settings')), false);
});

test('new-live-run-refreshes-cas-without-replacing-draft', async (t) => {
  const fx = await mountPipelines(t, { running: true });
  const legacy = {
    id: 'legacy-without-epoch',
    epoch: null,
    runner: 'claude',
  };

  fx.graphs[0].nodeMeta.browser.runner.attempts = [
    {
      id: 'run-current',
      epoch: 1,
      runner: 'claude',
    },
    legacy,
  ];
  await fx.wrapper.vm.load();
  await fx.open(0);
  await fx.wrapper.get('#stage-executors-tab').trigger('click');
  await settingsFields(fx.wrapper)[1].setValue('high');
  await fx.flushPromises();

  const current = fx.confirmedByTask.get(42);
  const nextRun = { id: 'run-after-restart', epoch: 2 };

  fx.confirmedByTask.set(42, {
    ...current,
    actual: { ...current.actual, run: nextRun },
  });
  fx.graphs[0].nodeMeta.browser.runner.attempts = [
    {
      ...nextRun,
      runner: 'claude',
      model: 'opus',
      effort: 'max',
    },
    legacy,
  ];
  await fx.wrapper.vm.load();
  await fx.flushPromises();
  assert.equal(settingsFields(fx.wrapper)[1].element.value, 'high');

  const requests = fx.optionsRequests.length;

  fx.graphs[0].nodeMeta.browser.tokens = 100;
  await fx.wrapper.vm.load();
  await fx.flushPromises();
  assert.equal(fx.optionsRequests.length, requests, 'обновление токенов не перечитывает каталог');
  await settingsFields(fx.wrapper)[1].setValue('max');
  await fx.flushPromises();

  const request = fx.posts.findLast((post) => post.url.endsWith('/runner/settings'));

  assert.deepEqual(request?.body.expectedRun, nextRun);
  assert.equal(request?.body.selection.effort, 'max');
});
