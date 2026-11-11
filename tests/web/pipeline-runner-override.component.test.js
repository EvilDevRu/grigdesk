import { loadProductModule, webFile } from './helpers/compile-vue.js';
import { migrationUrl } from './helpers/compile-vue.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compilePipelineView } from './helpers/pipeline-view.js';
import { settingsButton, settingsFields, stageSettingsOptions } from './helpers/stage-runner-settings.js';

process.env.NODE_ENV = 'test';

const TASKS_STORE_PATH = fileURLToPath(migrationUrl('src/stores/tasks.ts'));
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;

// Задача №42 на маршруте feature: два узла, у plan — runner-мета с заданным источником.
function makeFixture({
  status = 'wait', source = 'profile-stage', readOnly = false, actual = null, daemonAlive = true,
} = {}) {
  const factoryTask = {
    task: 42,
    profile: 'project-alpha',
    route: 'feature',
    readOnly,
    daemonAlive,
    attempt: 'a_0123456789abcdef0123456789abcdef',
    result: null,
    stall: null,
  };
  const graph = {
    daemonAlive,
    route: 'feature',
    readOnly,
    nodes: { plan: [0, '📋 План'], gate_plan: [1, '🚦 Ворота плана'] },
    pos: { plan: 0, gate_plan: 1 },
    keys: { plan: 'PLAN', gate_plan: 'GATE_PLAN' },
    runnerKeys: { plan: 'PLAN', gate_plan: 'GATE_PLAN' },
    statuses: { plan: status, gate_plan: 'pending' },
    nodeMeta: {
      plan: {
        runner: {
          primary: 'claude',
          failover: ['codex'],
          chain: ['claude', 'codex'],
          source,
          actual,
          model: null,
          models: {
            claude: {
              family: 'opus',
              version: 'latest',
              effort: 'max'
            },
            codex: {
              family: 'sol',
              version: 'latest',
              effort: 'ultra'
            },
          },
          attempts: [],
          reason: null,
          switched: false,
        },
      },
    },
    progress: {
      done: 0,
      total: 2,
      current: 'plan'
    },
  };

  return { factoryTask, graph };
}

/**
 * Стенд страницы держит раздельные confirmed/options и telemetry графа.
 * Happy-dom и сторы изолируют только внешние границы настоящего редактора.
 */
async function mountPipeline(t, {
  factoryTask, graph, runners = ['claude', 'codex'], applyOverride = false,
  optionsHandler = null, applyHandler = null, settings = null,
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
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true
    });
  }

  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const getCalls = [];
  const runnerCalls = [];
  const applyCalls = [];
  const optionCalls = [];
  let confirmed = settings || stageSettingsOptions({
    running: graph.statuses.plan === 'run' && graph.daemonAlive,
  });

  if (!settings && graph.nodeMeta.plan.runner.source === 'task-stage') {
    confirmed.selection.primary = graph.nodeMeta.plan.runner.primary;
    confirmed.sources.primary = 'task-stage';
  }

  globalThis.__pipelineRunnerApi = {
    /**
     * Маршруты читают один согласованный снимок задачи, графа и списка исполнителей.
     * Неожиданный URL остаётся видимым ошибкой фикстуры вместо обращения в живой API.
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
        return { runners };
      }
      if (url.includes('/runner/options')) {
        optionCalls.push(url);

        if (optionsHandler) {
          return optionsHandler(url, confirmed);
        }

        const provider = new URL(url, 'http://fixture').searchParams.get('provider')
          || confirmed.selection.parametersFor;

        return provider === confirmed.selection.parametersFor
          ? confirmed
          : stageSettingsOptions({ provider });
      }
      if (url.includes('/instruction')) {
        return { text: '' };
      }

      return {};
    },
    /**
     * Подтверждает целую selection после явного действия и сохраняет actual отдельно.
     * Повторное открытие читает обновлённый снимок через тот же options endpoint.
     */
    async post(url, payload) {
      if (url.endsWith('/runner/settings')) {
        applyCalls.push([url, payload]);

        if (applyHandler) {
          return applyHandler(payload);
        }

        const next = stageSettingsOptions({ provider: payload.selection.parametersFor });

        confirmed = {
          ...next,
          actual: confirmed.actual,
          effective: {
            primary: payload.selection.primary || payload.selection.parametersFor,
            model: payload.selection.model ?? next.effective.model,
            effort: payload.selection.effort ?? next.effective.effort,
          },
          selection: { ...payload.selection },
          revision: confirmed.revision + 1,
          receipt: { requestId: payload.requestId, state: payload.mode === 'restart' ? 'pending' : 'saved' },
        };

        return confirmed;
      }

      return { ok: true };
    },
  };
  globalThis.__pipelineRunnerConfirmDialog = async () => true;
  globalThis.__pipelineRunnerAlertDialog = async () => {};
  globalThis.__pipelineRunnerFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineRunnerUiStore = defineStore('pipeline-runner-ui', {
    actions: { openTask() {} },
  });
  globalThis.__pipelineRunnerTasksStore = defineStore('pipeline-runner-tasks', {
    actions: {
      async load() {
         return {};
      },
      title() {
         return null;
      },
      async getStageRunnerOptions(id, query) {
        return globalThis.__pipelineRunnerApi.get(
          `/api/tasks/${id}/runner/options?${new URLSearchParams(query)}`,
        );
      },
      async applyStageRunnerSettings(id, payload) {
        return globalThis.__pipelineRunnerApi.post(`/api/tasks/${id}/runner/settings`, payload);
      },
      async setStageRunner(id, stage, primary) {
        runnerCalls.push([id, stage, primary]);
        // Сервер применил override: следующий /graph отдаст новый primary и источник.
        if (applyOverride && primary) {
          Object.assign(graph.nodeMeta.plan.runner, { primary, source: 'task-stage' });
        }

        return { ok: true };
      },
    },
  });
  globalThis.__pipelineRunnerBoardStore = defineStore('pipeline-runner-board', {
    state: () => ({ data: null }),
    actions: { async load() {} },
  });

  const wrapper = mount(await compilePipelineView('__pipelineRunner'), {
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
      '__pipelineRunnerApi',
      '__pipelineRunnerConfirmDialog',
      '__pipelineRunnerAlertDialog',
      '__pipelineRunnerFactoryGraph',
      '__pipelineRunnerUiStore',
      '__pipelineRunnerTasksStore',
      '__pipelineRunnerBoardStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  // Клик по узлу графа: стаб FactoryGraph просто эмитит то, что сказали.
  const openStage = async (node) => {
    wrapper.findComponent(globalThis.__pipelineRunnerFactoryGraph).vm.$emit('node', node);
    await flushPromises();
  };
  const openPlanStage = async (status) => {
    await openStage({
      id: 'plan',
      label: '📋 План',
      subtitle: '',
      status,
    });
    await wrapper.get('#stage-executors-tab').trigger('click');
  };

  return {
    wrapper,
    flushPromises,
    getCalls,
    runnerCalls,
    applyCalls,
    optionCalls,
    readConfirmed: () => confirmed,
    openStage,
    openPlanStage
  };
}

test('selection-is-draft', async (t) => {
  const fx = await mountPipeline(t, makeFixture());

  await fx.openPlanStage('wait');
  await fx.wrapper.findAll('.executor-row .ui-selectable-row__primary')[1].trigger('click');
  await fx.flushPromises();
  assert.deepEqual(fx.runnerCalls, [], 'выбор исполнителя не вызывает legacy override');
  assert.deepEqual(fx.applyCalls, [], 'черновик не сохраняется до явного действия');

  const fields = settingsFields(fx.wrapper);

  assert.ok(fields.length >= 2);
  assert.equal(fields[0].element.disabled, false);
  await fields[0].setValue('sol-other');
  await fields[1].setValue('low');
  assert.deepEqual(fx.applyCalls, []);
});

test('apply-one-tuple-keeps-dialog', async (t) => {
  const fx = await mountPipeline(t, makeFixture());

  await fx.openPlanStage('wait');
  await fx.wrapper.findAll('.executor-row .ui-selectable-row__primary')[1].trigger('click');
  await fx.flushPromises();

  const fields = settingsFields(fx.wrapper);

  assert.equal(fields[0].element.disabled, false);
  await fields[0].setValue('sol-other');
  await fields[1].setValue('low');
  await settingsButton(fx.wrapper, /^Применить$/).trigger('click');
  await fx.flushPromises();
  assert.equal(fx.applyCalls.length, 1);
  assert.deepEqual(fx.applyCalls[0][1].selection, {
    primary: 'codex',
    parametersFor: 'codex',
    model: 'sol-other',
    effort: 'low',
  });
  assert.deepEqual(fx.applyCalls[0][1].identity, {
    task: '42',
    profile: 'project-alpha',
    attempt: 'a_0123456789abcdef0123456789abcdef',
    node: 'plan',
    stage: 'PLAN',
  });
  assert.equal(fx.applyCalls[0][1].mode, 'next');
  assert.equal(fx.wrapper.find('.smodal').exists(), true);
  assert.deepEqual(fx.runnerCalls, []);
});

test('карточка текущего исполнителя запроса не шлёт', async (t) => {
  const { wrapper, runnerCalls, openPlanStage } = await mountPipeline(t, makeFixture());

  await openPlanStage('wait');

  await wrapper.findAll('.executor-row .ui-selectable-row__primary')[0].trigger('click');
  assert.deepEqual(runnerCalls, []);
});

test('options-models-and-efforts-match-selected-provider', async (t) => {
  const fx = await mountPipeline(t, makeFixture());

  await fx.openPlanStage('wait');

  const fields = settingsFields(fx.wrapper);

  assert.equal(fields[0].element.disabled, false);
  assert.ok(fields[0].findAll('option').some((item) => item.element.value === 'opus-other'));
  await fields[0].setValue('opus-other');
  await fx.flushPromises();
  assert.ok(fields[1].findAll('option').some((item) => item.element.value === 'low'));
  assert.equal(fields[1].findAll('option').some((item) => item.element.value === 'max'), false);
  assert.deepEqual(fx.applyCalls, []);
});

test('результат открывается первым, переход между вкладками сохраняет указание агенту', async (t) => {
  const { wrapper, runnerCalls, openStage } = await mountPipeline(t, makeFixture());

  await openStage({
    id: 'plan',
    label: '📋 План',
    status: 'done',
  });

  assert.equal(wrapper.get('#stage-result-tab').attributes('aria-selected'), 'true');
  await wrapper.get('#rewind-free').setValue('Повтори проверку с новым условием');
  await wrapper.get('#stage-executors-tab').trigger('click');
  assert.equal(wrapper.get('.srail').isVisible(), false);
  assert.equal(wrapper.get('#stage-executors-panel').isVisible(), true);
  await wrapper.get('#stage-result-tab').trigger('click');
  assert.equal(wrapper.get('#rewind-free').element.value, 'Повтори проверку с новым условием');
  assert.deepEqual(runnerCalls, []);
});

test('модалка показывает policy effort до запуска и фактический effort в попытке', async (t) => {
  const fixture = makeFixture({ status: 'done', actual: 'codex' });

  Object.assign(fixture.graph.nodeMeta.plan.runner, {
    model: 'gpt-5.6-sol',
    attempts: [{
      id: 'run-1',
      epoch: 1,
      runner: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      result: 'ok',
    }],
  });

  const { wrapper, openPlanStage } = await mountPipeline(t, fixture);

  await openPlanStage('done');

  const hops = wrapper.findAll('.runner-hop');

  assert.match(hops[0].text(), /opus · effort max/);
  // У уже запущенного Codex telemetry xhigh важнее обновлённой policy ultra.
  assert.match(hops[1].text(), /gpt-5\.6-sol · effort xhigh/);
  assert.match(wrapper.get('.runner-attempt').text(), /gpt-5\.6-sol · effort xhigh/);
});

for (const [runner, model, failureDetail] of [
  ['claude', 'claude-test', 'Закончилась квота'],
  ['codex', 'codex-test', 'Закончилась квота'],
  ['deepseek', 'deepseek-test', 'Оборвалась связь с провайдером'],
  ['glm', 'glm-5.3', 'GLM недоступен: проверь карточку (glm_key_missing)'],
  ['kimi', 'kimi-code/k3', 'Закончилась квота'],
]) {
  test(`журнал попыток ${runner} показывает конкретную причину вместо unknown`, async (t) => {
    const fixture = makeFixture({ status: 'failed', actual: runner });

    Object.assign(fixture.graph.nodeMeta.plan.runner, {
      primary: runner,
      chain: [runner],
      model,
      models: { [runner]: {
        family: 'default',
        label: model,
        effort: 'high',
      } },
      attempts: [{
        id: `run-${runner}`,
        epoch: 1,
        runner,
        model,
        effort: 'high',
        result: 'unknown',
        failureDetail,
      }],
    });
    fixture.factoryTask.stall = {
      kind: 'human',
      stop: 'human',
      outcome: 'exhausted',
      node: 'plan',
      stage: 'PLAN',
      title: `PLAN: ${failureDetail}`,
      hint: 'Проверьте сообщение провайдера.',
      presentation: {
        reason: 'агент не вернул результат',
        summary: 'Проверьте сообщение провайдера перед повтором этапа.',
        details: { what: 'Результат этапа не получен.' },
        attempts: 1,
        lastFailure: failureDetail,
        model,
      },
    };

    const { wrapper, openPlanStage } = await mountPipeline(t, { ...fixture, runners: [runner] });

    assert.equal(wrapper.get('.stop-failure').text(), failureDetail);
    assert.equal(wrapper.get('.stop-model').text(), model);

    await openPlanStage('failed');

    assert.equal(wrapper.get('.runner-result').text(), failureDetail);
    assert.ok(wrapper.get('.runner-attempt').text().includes(`${model} · effort high`));
    assert.doesNotMatch(wrapper.get('.runner-attempt').text(), /неизвестная ошибка|\["zai"/);
  });
}

test('старый сервер без failureDetail показывает код отказа вместо неизвестной ошибки', async (t) => {
  const fixture = makeFixture({ status: 'failed', actual: 'codex' });

  fixture.graph.nodeMeta.plan.runner.attempts = [{
    id: 'run-no-message',
    runner: 'codex',
    result: 'unknown',
    rc: 7,
  }];

  const { wrapper, openPlanStage } = await mountPipeline(t, fixture);

  await openPlanStage('failed');

  assert.equal(wrapper.get('.runner-result').text(),
    'Процесс завершился с кодом 7; исполнитель не сообщил причину');
});

test('ручной запуск без Bitrix показывает заголовок сохранённого тикета', async (t) => {
  const fixture = makeFixture();

  fixture.factoryTask.title = 'Исправить источник задачи API';

  const { wrapper } = await mountPipeline(t, fixture);

  const title = wrapper.get('.ctitle');

  assert.equal(title.text(), 'Исправить источник задачи API');
  assert.equal(title.element.tagName, 'SPAN');
  assert.equal(wrapper.text().includes('загрузка названия'), false);
});

test('reset-executor-is-draft', async (t) => {
  const fx = await mountPipeline(t, makeFixture({ source: 'task-stage' }));

  await fx.openPlanStage('idle');
  await fx.wrapper.get('.runner-reset').trigger('click');
  assert.deepEqual(fx.runnerCalls, []);
  assert.deepEqual(fx.applyCalls, []);
  await settingsButton(fx.wrapper, /^Применить$/).trigger('click');
  await fx.flushPromises();
  assert.equal(fx.applyCalls[0][1].selection.primary, null);
});

test('источник не task-stage: кнопки «Сбросить» нет', async (t) => {
  const { wrapper, openPlanStage } = await mountPipeline(t, makeFixture({ source: 'task' }));

  await openPlanStage('wait');

  assert.ok(wrapper.get('.runner-override').exists());
  assert.equal(wrapper.find('.runner-reset').exists(), false);
});

test('active-next-preserves-fact', async (t) => {
  const fixture = makeFixture({ status: 'run', actual: 'claude' });

  fixture.graph.nodeMeta.plan.runner.model = 'opus';
  fixture.graph.nodeMeta.plan.runner.attempts = [{
    id: 'run-current',
    epoch: 1,
    runner: 'claude',
    model: 'opus',
    effort: 'high',
    result: null,
  }];

  const fx = await mountPipeline(t, fixture);

  await fx.openPlanStage('run');

  const fields = settingsFields(fx.wrapper);

  assert.equal(fields[0].element.disabled, false);
  await fields[0].setValue('opus-other');
  await fields[1].setValue('low');
  await settingsButton(fx.wrapper, /Сохранить для следующего запуска/).trigger('click');
  await fx.flushPromises();
  assert.equal(fx.applyCalls.length, 1);
  assert.equal(fx.applyCalls[0][1].mode, 'next');
  assert.match(fx.wrapper.get('.runner-attempt').text(), /opus · effort high/);
  assert.equal(fixture.graph.nodeMeta.plan.runner.model, 'opus');
  assert.equal(fx.wrapper.find('.smodal').exists(), true);
});

test('остановленный run: черновик сохраняется для следующего resume', async (t) => {
  const { wrapper, runnerCalls, openPlanStage } = await mountPipeline(
    t,
    makeFixture({
      status: 'run',
      actual: 'claude',
      daemonAlive: false
    }),
  );

  await openPlanStage('run');

  assert.equal(wrapper.find('.runner-switches').exists(), false);

  const block = wrapper.get('.runner-override');

  assert.match(block.text(), /Прогон остановлен/);
  assert.match(block.text(), /Продолжить прогон/);

  await wrapper.findAll('.executor-row .ui-selectable-row__primary')[1].trigger('click');
  assert.deepEqual(runnerCalls, []);
  assert.ok(settingsButton(wrapper, /^Применить$/).exists());
});

test('readOnly: блока выбора исполнителя нет', async (t) => {
  const { wrapper, openPlanStage } = await mountPipeline(t, makeFixture({ readOnly: true }));

  await openPlanStage('wait');

  assert.ok(wrapper.get('.runner-sect').exists());
  assert.equal(wrapper.find('.runner-override').exists(), false);
});

// Сам store-action — отдельно и по-настоящему: URL и тело запроса.
test('tasks.setStageRunner шлёт POST /api/tasks/:id/runner/override (пустой primary — снятие)', async () => {
  globalThis.__pipelineRunnerStoreApi = {
    posts: [],
    async post(url, body) {
       this.posts.push([url, body]);

      return { ok: true };
    },
  };

  const [{ createPinia, setActivePinia }, { useTasksStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    loadProductModule('src/stores/tasks.ts', {
      '../shared/apiClient.ts': [
        'export const api = globalThis.__pipelineRunnerStoreApi;',
        `export { ApiError } from ${JSON.stringify(webFile('src/shared/apiClient.ts'))};`,
      ].join('\n'),
      './board.ts': 'export const useBoardStore = () => ({load: async () => {}});',
    }),
  ]);

  setActivePinia(createPinia());

  const store = useTasksStore();

  await store.setStageRunner(42, 'PLAN', 'codex');
  await store.setStageRunner(42, 'PLAN', '');
  assert.deepEqual(globalThis.__pipelineRunnerStoreApi.posts, [
    ['/api/tasks/42/runner/override', { stage: 'PLAN', primary: 'codex' }],
    ['/api/tasks/42/runner/override', { stage: 'PLAN', primary: '' }],
  ]);
  delete globalThis.__pipelineRunnerStoreApi;
});

// К2/К6: тот же provider, изменение только effort, отмена и явное подтверждение.
test('same-provider-effort-restart', async (t) => {
  const fx = await mountPipeline(t, makeFixture({ status: 'run', actual: 'claude' }));
  const confirmations = [];

  globalThis.__pipelineRunnerConfirmDialog = async (...args) => {
    confirmations.push(args);

    return false;
  };
  await fx.openPlanStage('run');

  const fields = settingsFields(fx.wrapper);

  assert.equal(fields[1].element.disabled, false);
  await fields[1].setValue('high');
  await settingsButton(fx.wrapper, /Перезапустить с этими параметрами/).trigger('click');
  await fx.flushPromises();
  assert.equal(confirmations.length, 1);
  assert.match(JSON.stringify(confirmations[0]), /останов|заверш|прерв/i);
  assert.deepEqual(fx.applyCalls, []);

  globalThis.__pipelineRunnerConfirmDialog = async () => true;
  await settingsButton(fx.wrapper, /Перезапустить с этими параметрами/).trigger('click');
  await fx.flushPromises();
  assert.equal(fx.applyCalls.length, 1);
  assert.equal(fx.applyCalls[0][1].mode, 'restart');
  assert.deepEqual(fx.applyCalls[0][1].selection, {
    primary: null,
    parametersFor: 'claude',
    model: null,
    effort: 'high',
  });
  assert.deepEqual(fx.applyCalls[0][1].expectedRun, { id: 'run-current', epoch: 1 });
});

test('restart-refreshes-run-before-next-apply', async (t) => {
  const initial = stageSettingsOptions({ running: true });
  const nextRun = { id: 'run-restarted', epoch: 2 };
  let current = structuredClone(initial);
  const fx = await mountPipeline(t, {
    ...makeFixture({ status: 'run', actual: 'claude' }),
    optionsHandler: () => current,
    applyHandler: (payload) => {
      const accepted = {
        ...structuredClone(current),
        selection: { ...payload.selection },
        revision: current.revision + 1,
        receipt: { requestId: payload.requestId, state: 'pending' },
      };

      current = {
        ...structuredClone(accepted),
        actual: { ...initial.actual, run: nextRun },
      };

      return accepted;
    },
  });

  await fx.openPlanStage('run');
  await settingsFields(fx.wrapper)[1].setValue('high');
  await settingsButton(fx.wrapper, /Перезапустить с этими параметрами/).trigger('click');
  await fx.flushPromises();
  await settingsFields(fx.wrapper)[1].setValue('max');
  await settingsButton(fx.wrapper, /Сохранить для следующего запуска/).trigger('click');
  await fx.flushPromises();
  assert.equal(fx.applyCalls.length, 2);
  assert.deepEqual(fx.applyCalls[1][1].expectedRun, nextRun);
  assert.equal(fx.applyCalls[1][1].selection.effort, 'max');
});

// К3: каждое поле возвращается к наследованию без сброса второго.
test('independent-inheritance-and-remount', async (t) => {
  const settings = stageSettingsOptions();

  settings.selection = {
    primary: null,
    parametersFor: 'claude',
    model: 'opus-other',
    effort: 'high'
  };

  const fx = await mountPipeline(t, { ...makeFixture(), settings });

  await fx.openPlanStage('wait');

  const fields = settingsFields(fx.wrapper);

  assert.equal(fields[0].element.disabled, false);

  const inheritModel = fields[0].findAll('option').find((option) => /профил|наслед/i.test(option.text()));

  assert.ok(inheritModel, 'у модели есть независимое наследование');
  await fields[0].setValue(inheritModel.element.value);
  await settingsButton(fx.wrapper, /^Применить$/).trigger('click');
  await fx.flushPromises();
  assert.equal(fx.applyCalls.at(-1)[1].selection.model, null);
  assert.equal(fx.applyCalls.at(-1)[1].selection.effort, 'high');

  const inheritEffort = fields[1].findAll('option').find((option) => /профил|наслед/i.test(option.text()));

  assert.ok(inheritEffort, 'у effort есть независимое наследование');
  await fields[1].setValue(inheritEffort.element.value);
  await settingsButton(fx.wrapper, /^Применить$/).trigger('click');
  await fx.flushPromises();
  assert.equal(fx.applyCalls.at(-1)[1].selection.effort, null);

  const restored = await mountPipeline(t, { ...makeFixture(), settings: fx.readConfirmed() });

  await restored.openPlanStage('wait');
  assert.match(restored.wrapper.get('#stage-executors-panel').text(), /профил|наслед/i);
  assert.equal(restored.optionCalls.length > 0, true, 'после remount authority читается из API');
  assert.deepEqual(restored.applyCalls, []);
});

test('options-loading-empty-error-retry', async (t) => {
  await t.test('loading не разрешает сохранение до каталога', async (sub) => {
    const pending = Promise.withResolvers();
    const fx = await mountPipeline(sub, { ...makeFixture(), optionsHandler: () => pending.promise });

    await fx.openPlanStage('wait');
    assert.match(fx.wrapper.get('#stage-executors-panel').text(), /загруз|получаем/i);
    assert.deepEqual(fx.applyCalls, []);
    pending.resolve(stageSettingsOptions());
    await fx.flushPromises();
    assert.equal(settingsFields(fx.wrapper)[0].element.disabled, false);
  });

  await t.test('пустой каталог имеет явное состояние', async (sub) => {
    const options = stageSettingsOptions();

    options.models = [];

    const fx = await mountPipeline(sub, { ...makeFixture(), optionsHandler: () => options });

    await fx.openPlanStage('wait');
    assert.match(fx.wrapper.get('#stage-executors-panel').text(),
      /нет доступных|каталог.*пуст|модели.*недоступ/i);
    assert.deepEqual(fx.applyCalls, []);
  });

  await t.test('ошибка оставляет окно и даёт повторить discovery', async (sub) => {
    let count = 0;
    const fx = await mountPipeline(sub, {
      ...makeFixture(),
      optionsHandler: () => {
        count += 1;

        if (count === 1) {
          throw new Error('Каталог временно недоступен');
        }

        return stageSettingsOptions();
      },
    });

    await fx.openPlanStage('wait');
    assert.match(fx.wrapper.get('#stage-executors-panel').text(), /Каталог временно недоступен/);
    await settingsButton(fx.wrapper, /Повторить|Обновить/).trigger('click');
    await fx.flushPromises();
    assert.equal(count, 3, 'после bootstrap каталог выбранного исполнителя проверяется отдельно');
    assert.equal(settingsFields(fx.wrapper)[0].element.disabled, false);
    assert.equal(fx.wrapper.find('.smodal').exists(), true);
  });
});

test('provider-catalog-failure-clears-previous-models', async (t) => {
  let unavailable = true;
  const fx = await mountPipeline(t, {
    ...makeFixture(),
    optionsHandler: (url, confirmed) => {
      const provider = new URL(url, 'http://fixture').searchParams.get('provider')
        || confirmed.selection.parametersFor;

      if (provider === 'codex' && unavailable) {
        throw new Error('Каталог Codex недоступен');
      }

      return stageSettingsOptions({ provider });
    },
  });

  await fx.openPlanStage('wait');
  assert.ok(settingsFields(fx.wrapper)[0].findAll('option')
    .some((item) => item.element.value === 'opus-other'));
  await fx.wrapper.findAll('.executor-row .ui-selectable-row__primary')[1].trigger('click');
  await fx.flushPromises();

  const fields = fx.wrapper.findAll('.executor-row')[1].findAll('.executor-fields select');

  assert.equal(fields[0].element.disabled, true);
  assert.equal(fields[0].findAll('option').some((item) => item.element.value === 'opus-other'), false);
  assert.equal(settingsButton(fx.wrapper, /^Применить$/).element.disabled, true);
  assert.match(fx.wrapper.get('#stage-executors-panel').text(), /Каталог Codex недоступен/);

  unavailable = false;
  await settingsButton(fx.wrapper, /Повторить|Обновить/).trigger('click');
  await fx.flushPromises();
  assert.equal(fields[0].element.disabled, false);
  assert.ok(fields[0].findAll('option').some((item) => item.element.value === 'sol-other'));
  assert.deepEqual(fx.applyCalls, []);
});

test('saved-provider-bootstrap-does-not-depend-on-base-catalog', async (t) => {
  const saved = stageSettingsOptions({ provider: 'codex' });

  saved.selection = {
    primary: 'codex',
    parametersFor: 'codex',
    model: 'sol-other',
    effort: 'low',
  };
  saved.effective.model = 'sol-other';
  saved.effective.effort = 'low';

  const fx = await mountPipeline(t, {
    ...makeFixture(),
    settings: saved,
    optionsHandler: (url) => {
      const provider = new URL(url, 'http://fixture').searchParams.get('provider');

      if (provider === 'claude') {
        throw new Error('Каталог базового исполнителя недоступен');
      }

      return structuredClone(saved);
    },
  });

  await fx.openPlanStage('wait');
  assert.equal(fx.optionCalls.some((url) => /provider=claude/.test(url)), false);
  assert.equal(fx.optionCalls.some((url) => /provider=codex/.test(url)), true);
  assert.equal(settingsFields(fx.wrapper)[0].element.value, 'sol-other');
  assert.equal(settingsFields(fx.wrapper)[1].element.value, 'low');
  await settingsButton(fx.wrapper, /^Применить$/).trigger('click');
  await fx.flushPromises();
  assert.deepEqual(fx.applyCalls[0][1].selection, saved.selection);
});

test('unavailable-saved-catalog-keeps-visible-confirmed-parameters', async (t) => {
  const saved = stageSettingsOptions({ provider: 'codex' });

  saved.selection = {
    primary: 'codex',
    parametersFor: 'codex',
    model: 'sol-other',
    effort: 'low',
  };
  saved.effective.model = 'sol-other';
  saved.effective.effort = 'low';

  const fx = await mountPipeline(t, {
    ...makeFixture(),
    settings: saved,
    optionsHandler: (url) => {
      if (new URL(url, 'http://fixture').searchParams.has('provider')) {
        throw new Error('Каталог сохранённого исполнителя недоступен');
      }

      return { ...structuredClone(saved), models: [] };
    },
  });

  await fx.openPlanStage('wait');

  const fields = settingsFields(fx.wrapper);

  assert.equal(fields[0].element.value, 'sol-other');
  assert.equal(fields[1].element.value, 'low');
  assert.equal(fields[0].element.disabled, true);
  assert.equal(settingsButton(fx.wrapper, /^Применить$/).element.disabled, true);
  assert.match(fx.wrapper.get('#stage-executors-panel').text(), /Следующий запуск: sol-other · effort low/);
  assert.match(fx.wrapper.get('#stage-executors-panel').text(),
    /Каталог сохранённого исполнителя недоступен/);
  assert.deepEqual(fx.applyCalls, []);
});
