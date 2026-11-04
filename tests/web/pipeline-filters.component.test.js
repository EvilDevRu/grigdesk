// Тулбар фильтров конвейера: арифметика чипов и знаменатель сводки.
//
// Обе величины уже расходились с тем, что видит человек. Чипы состояний считались
// взаимоисключающими категориями вотчера, а «Все» — всеми задачами проекта, поэтому
// завершённый прогон не попадал никуда и сумма не сходилась с «Все». Знаменатель сводки
// брал весь список задач, игнорируя выбранный проект, — «показано 1 из 5» при четырёх
// задачах проекта. Ни то, ни другое не падает и не пишет в журнал: цифра просто врёт.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compilePipelineView } from './helpers/pipeline-view.js';

process.env.NODE_ENV = 'test';

function graphOf({ gate = 'done', current = 'build' } = {}) {
  return {
    route: 'feature',
    readOnly: false,
    fePort: null,
    sandbox: null,
    nodes: { gate_plan: [0, '🚦 План'], build: [1, '🔧 Сборка'] },
    pos: { gate_plan: 0, build: 1 },
    keys: { gate_plan: 'GATE_PLAN', build: 'BUILD' },
    statuses: { gate_plan: gate, build: gate === 'wait' ? 'pending' : 'run' },
    nodeMeta: {},
    progress: { done: 1, total: 2, current },
  };
}

// Четыре задачи проекта закрывают все четыре категории чипов, пятая принадлежит
// соседнему проекту: без неё знаменатель «всего» не отличить от знаменателя проекта.
const FIXTURE = [
  { task: 8210, profile: 'alpha', daemonAlive: false, result: 'completed', graph: graphOf() },
  { task: 8408, profile: 'alpha', daemonAlive: true, result: null, graph: graphOf({ gate: 'wait' }) },
  {
    task: 8507,
    profile: 'alpha',
    daemonAlive: false,
    result: 'stopped-human',
    stall: { kind: 'human', stop: 'human', stage: 'BUILD', title: 'BUILD: узел позвал человека' },
    graph: graphOf(),
  },
  { task: 8512, profile: 'alpha', daemonAlive: true, result: null, graph: graphOf() },
  { task: 900028, profile: 'beta', daemonAlive: true, result: null, graph: graphOf() },
];

/**
 * Монтирует настоящий экран с управляемыми снимками и ответами команд.
 * Каждая проверка получает отдельный DOM и очищает границы после завершения.
 */
async function mountPipeline(t, {
  project = 'all',
  status = 'all',
  fixtures = FIXTURE,
  post = async () => ({ ok: true }),
  onGet = () => {},
  width = 1024,
} = {}) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/pipeline' });

  browser.happyDOM.setWindowSize({ width, height: 844 });

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
  browser.localStorage.setItem('grigdesk-pipeline-project', project);
  browser.localStorage.setItem('grigdesk-pipeline-status', status);
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  globalThis.__pipelineFiltersConfirmDialog = async () => true;
  globalThis.__pipelineFiltersAlertDialog = async () => {};
  globalThis.__pipelineFiltersApi = {
    /**
     * Возвращает согласованные список и графы из фикстуры текущей проверки.
     * Наблюдатель считает перечитывания без доступа к состоянию компонента.
     */
    async get(url) {
      url = url.replace(/\?sources=1$/u, '');
      onGet(url);

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
    post,
  };
  globalThis.__pipelineFiltersFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineFiltersUiStore = defineStore('pipeline-filters-ui', {
    actions: { openTask() {} },
  });
  globalThis.__pipelineFiltersTasksStore = defineStore('pipeline-filters-tasks', {
    actions: { async load() { return {}; }, title() { return 'Задача'; } },
  });
  globalThis.__pipelineFiltersBoardStore = defineStore('pipeline-filters-board', {
    state: () => ({ data: null }),
    actions: { async load() {} },
  });
  const wrapper = mount(await compilePipelineView('__pipelineFilters'), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__pipelineFiltersApi', '__pipelineFiltersConfirmDialog', '__pipelineFiltersAlertDialog',
      '__pipelineFiltersFactoryGraph', '__pipelineFiltersUiStore', '__pipelineFiltersTasksStore',
      '__pipelineFiltersBoardStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  await flushPromises();
  browser.dispatchEvent(new browser.Event('resize'));

  return {
    wrapper,
    flushPromises,
    browser,
  };
}

function statusCounts(wrapper) {
  const counts = new Map();

  for (const chip of wrapper.findAll('[data-role="pipeline-status-filter"]')) {
    counts.set(chip.attributes('data-status'), Number(chip.find('.status-count').text()));
  }

  return counts;
}

test('чип «Все» равен сумме остальных состояний', async (t) => {
  const { wrapper } = await mountPipeline(t, { project: 'alpha' });
  const counts = statusCounts(wrapper);

  assert.equal(counts.get('all'), 4);
  assert.equal(
    counts.get('running') + counts.get('waiting') + counts.get('error') + counts.get('inactive'),
    counts.get('all'),
  );
  // Именно эта задача и терялась: завершённый прогон с мёртвым демоном не попадает
  // ни в одну категорию вотчера, а из «Все» его никто не вычитал.
  assert.equal(counts.get('inactive'), 1);
});

test('состояния считаются внутри выбранного проекта', async (t) => {
  const { wrapper } = await mountPipeline(t, { project: 'alpha' });

  assert.equal(statusCounts(wrapper).get('running'), 1);
});

// Проекты снова являются главным рядом: кнопка даёт переключение в один клик, а число
// остаётся рядом с именем и не смешивается со вторичным «Все» состояний.
test('проекты занимают главный ряд и показывают собственные числа', async (t) => {
  const { wrapper } = await mountPipeline(t, { project: 'alpha' });
  const buttons = wrapper.findAll('button[data-role="pipeline-project"]');

  assert.deepEqual(
    buttons.map((button) => button.attributes('data-project')),
    ['all', 'alpha', 'beta'],
  );
  assert.deepEqual(
    buttons.map((button) => button.text().replace(/\s+/gu, ' ').trim()),
    ['Все5', 'alpha4', 'beta1'],
  );
  assert.equal(buttons[1].attributes('aria-pressed'), 'true');
  assert.equal(wrapper.find('select#pipeline-project').exists(), false);
});

test('проекты занимают свободный левый участок, состояния и вид прижаты вправо', async (t) => {
  const { wrapper } = await mountPipeline(t, { project: 'alpha' });
  const toolbar = wrapper.get('.toolbar');
  const groups = [...toolbar.element.children].map((node) => node.className);
  const view = wrapper.get('.compact-view-controls');
  const options = view.findAll('[data-option]');
  const style = readFileSync(
    new URL('../../web/src/views/PipelineView.vue', import.meta.url),
    'utf8',
  );

  assert.equal(groups.length, 3);
  assert.equal(groups[0], 'pipeline-run-controls');
  assert.equal(groups[1], 'project-strip');
  assert.equal(groups[2], 'toolbar-secondary');
  assert.equal(toolbar.find('.secondary-status-filters').exists(), true);
  assert.deepEqual(options.map((button) => button.attributes('data-option')), ['loops', 'compact']);
  assert.ok(options.every((button) => button.attributes('data-variant') === 'ghost'));
  assert.ok(options.every((button) => button.attributes('aria-label')));
  assert.ok(options.every((button) => button.text().trim() === ''));
  assert.match(
    style,
    /\.toolbar\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/su,
  );
  assert.equal(wrapper.get('.pipeline-toolbar').classes().includes('ui-pane-header'), true);
  assert.equal(wrapper.get('.pipeline-content').classes().includes('ui-workspace-page__body'), true);
  assert.doesNotMatch(style, /\.toolbar::before\s*\{/u);
  assert.match(style, /\.toolbar-secondary\s*\{[^}]*display:\s*flex;/su);
});

test('смена проекта кнопкой пересчитывает состояния', async (t) => {
  const { wrapper, flushPromises } = await mountPipeline(t, { project: 'alpha' });

  await wrapper.get('button[data-role="pipeline-project"][data-project="beta"]').trigger('click');
  await flushPromises();

  const counts = statusCounts(wrapper);
  assert.equal(counts.get('all'), 1);
  assert.equal(counts.get('running'), 1);
});

// Подпись теперь остаётся видимой на любой ширине, а aria-label даёт имя с числом.
test('у каждого состояния остаются видимая подпись и доступное имя', async (t) => {
  const { wrapper } = await mountPipeline(t, { project: 'alpha' });
  const chips = wrapper.findAll('[data-role="pipeline-status-filter"]');

  assert.equal(chips.length, 5);
  for (const chip of chips) {
    assert.match(chip.attributes('aria-label'), /^[^:]+: \d+$/u);
    assert.ok(chip.find('.status-filter-label').text());
  }
});

test('непоместившиеся проекты уходят в +N, а выбранный возвращается в ряд', async (t) => {
  const { wrapper, flushPromises } = await mountPipeline(t, { project: 'beta' });
  const strip = wrapper.get('.project-strip');
  const widths = { all: 60, alpha: 70, beta: 60 };

  Object.defineProperty(strip.element, 'clientWidth', {
    configurable: true,
    value: 200,
  });
  for (const frame of wrapper.findAll('[data-project-measure]')) {
    const width = widths[frame.attributes('data-project-measure')];
    frame.element.getBoundingClientRect = () => ({ width });
  }
  wrapper.get('[data-project-more-measure]').element.getBoundingClientRect = () => ({ width: 50 });

  // Изменение выбора запускает тот же пересчёт, что ResizeObserver в браузере.
  await wrapper.get('button[data-role="pipeline-project"][data-project="alpha"]').trigger('click');
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    wrapper.findAll('button[data-role="pipeline-project"]')
      .map((button) => button.attributes('data-project')),
    ['all', 'alpha'],
  );
  const more = wrapper.get('button[data-role="pipeline-project-overflow"]');
  assert.match(more.text(), /\+1/u);

  await more.trigger('click');
  const hiddenBeta = wrapper.get(
    'button[data-role="pipeline-project-overflow-option"][data-project="beta"]',
  );
  await hiddenBeta.trigger('click');
  await flushPromises();
  await flushPromises();

  assert.equal(
    wrapper.get('button[data-role="pipeline-project"][data-project="beta"]')
      .attributes('aria-pressed'),
    'true',
  );
});

test('пустая выборка сбрасывает состояние, но сохраняет выбранный проект', async (t) => {
  const { wrapper, flushPromises } = await mountPipeline(t, {
    project: 'beta',
    status: 'waiting',
  });

  assert.equal(wrapper.find('.filter-empty').exists(), true);
  await wrapper.get('.filter-empty button').trigger('click');
  await flushPromises();

  assert.equal(
    wrapper.get('button[data-role="pipeline-project"][data-project="beta"]')
      .attributes('aria-pressed'),
    'true',
  );
  assert.equal(wrapper.find('.filter-empty').exists(), false);
  assert.equal(wrapper.findAll('.card').length, 1);
  assert.equal(localStorage.getItem('grigdesk-pipeline-status'), 'all');
});

// Цвет точки живёт в CSS и берётся из тона самой кнопки. Переименуй тон — и точки молча
// станут серыми: ни ошибки, ни падения теста тут нет, а именно цветом человек и различает
// «ждут решения» и «проблемы» на беглый взгляд.
test('каждому тону чипа отвечает своё правило точки', async (t) => {
  const { wrapper } = await mountPipeline(t);
  const style = readFileSync(
    new URL('../../web/src/views/PipelineView.vue', import.meta.url),
    'utf8',
  );

  const tones = new Set(
    wrapper.findAll('[data-role="pipeline-status-filter"]')
      .map((chip) => chip.attributes('data-tone'))
      .filter((tone) => tone && tone !== 'neutral'),
  );

  assert.deepEqual([...tones].sort(), ['accent', 'danger', 'warning']);
  for (const tone of tones) {
    assert.ok(
      style.includes(`.status-dot[data-tone='${tone}']`),
      `нет правила точки для тона ${tone}`,
    );
  }
});

const BULK_FIXTURE = [
  {
    task: 1101,
    profile: 'alpha',
    attempt: 'one',
    daemonAlive: false,
  },
  {
    task: 1102,
    profile: 'beta',
    attempt: 'two',
    daemonAlive: false,
    result: 'stopped-human',
  },
  {
    task: 1103,
    profile: 'alpha',
    attempt: 'three',
    daemonAlive: true,
  },
  {
    task: 1104,
    profile: 'beta',
    attempt: 'four',
    daemonAlive: true,
  },
  {
    task: 1105,
    profile: 'alpha',
    attempt: 'five',
    daemonAlive: false,
    result: 'completed',
  },
  {
    task: 1106,
    profile: 'alpha',
    attempt: 'six',
    daemonAlive: false,
    result: 'abandoned',
  },
  {
    task: 1107,
    profile: 'alpha',
    daemonAlive: false,
  },
  {
    task: 1108,
    profile: 'alpha',
    attempt: 'eight',
    daemonAlive: false,
    readOnly: true,
  },
  {
    task: 1109,
    profile: 'beta',
    attempt: 'nine',
    daemonAlive: true,
    readOnly: true,
  },
  {
    task: 1110,
    profile: 'alpha',
    attempt: 'ten',
    daemonAlive: false,
    result: 'failed',
  },
].map((task) => ({ ...task, graph: graphOf() }));

async function chooseBulk(wrapper, action, scope) {
  await wrapper.get(`.pipeline-run-controls [data-option="${action}"]`).trigger('click');
  await wrapper.get(`[data-bulk-action="${action}"][data-bulk-scope="${scope}"]`).trigger('click');
}

test('Плей и Стоп стоят перед вкладками, за ними разделитель; нажатие открывает меню', async (t) => {
  const calls = [];
  const { wrapper } = await mountPipeline(t, {
    fixtures: BULK_FIXTURE,
    post: async (url) => calls.push(url),
  });
  const controls = wrapper.get('.pipeline-run-controls');
  const buttons = controls.findAll('button');

  assert.deepEqual(buttons.map((button) => button.attributes('data-option')), ['resume', 'stop']);
  assert.equal(controls.element.lastElementChild.className, 'pipeline-run-separator');
  assert.ok(buttons.every((button) => button.attributes('aria-haspopup') === 'menu'));

  await buttons[0].trigger('click');

  assert.deepEqual(
    wrapper.findAll('[data-bulk-action="resume"] .pipeline-run-option > span')
      .map((label) => label.text()),
    ['Запустить все', 'Запустить все во вкладке'],
  );
  assert.deepEqual(calls, []);
});

for (const scenario of [
  {
    action: 'resume',
    scope: 'all',
    expected: [1101, 1102, 1110],
    status: 'running',
  },
  {
    action: 'resume',
    scope: 'project',
    expected: [1101, 1110],
    status: 'running',
  },
  {
    action: 'stop',
    scope: 'all',
    expected: [1103, 1104],
    status: 'inactive',
  },
  {
    action: 'stop',
    scope: 'project',
    expected: [1103],
    status: 'inactive',
  },
]) {
  test(`${scenario.action}/${scenario.scope}: только подходящие прогоны независимо от фильтра`, async (t) => {
    const calls = [];
    const { wrapper, flushPromises } = await mountPipeline(t, {
      project: 'alpha',
      status: scenario.status,
      fixtures: BULK_FIXTURE,
      post: async (url, body) => calls.push({ url, body }),
    });

    await chooseBulk(wrapper, scenario.action, scenario.scope);
    await flushPromises();

    assert.deepEqual(calls.map((call) => call.url), scenario.expected.map((task) => (
      `/api/tasks/${task}/${scenario.action}`
    )));

    if (scenario.action === 'resume') {
      assert.deepEqual(calls[0].body, { attempt: 'one', profile: 'alpha' });
    }

    assert.equal(wrapper.find('[data-bulk-action]').exists(), false);
  });
}

test('во вкладке «Все» команда охватывает оба проекта', async (t) => {
  const calls = [];
  const { wrapper, flushPromises } = await mountPipeline(t, {
    fixtures: BULK_FIXTURE,
    post: async (url) => calls.push(url),
  });

  await chooseBulk(wrapper, 'stop', 'project');
  await flushPromises();

  assert.deepEqual(calls, ['/api/tasks/1103/stop', '/api/tasks/1104/stop']);
});

test('команда без подходящих прогонов недоступна и не отправляет запросов', async (t) => {
  const calls = [];
  const { wrapper } = await mountPipeline(t, {
    fixtures: BULK_FIXTURE.filter((task) => task.result === 'completed' || task.readOnly),
    post: async (url) => calls.push(url),
  });

  await wrapper.get('.pipeline-run-controls [data-option="resume"]').trigger('click');

  const options = wrapper.findAll('[data-bulk-action="resume"]');

  assert.equal(options.length, 2);
  assert.ok(options.every((option) => option.element.disabled));

  await options[0].trigger('click');

  assert.deepEqual(calls, []);
});

test('пакет блокирует повторы, продолжает после ошибки и перечитывает список один раз', async (t) => {
  const calls = [];
  const alerts = [];
  const snapshots = [];
  let releaseFirst;
  const pending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const { wrapper, flushPromises } = await mountPipeline(t, {
    project: 'alpha',
    fixtures: BULK_FIXTURE,
    onGet: (url) => {
      if (url === '/api/tasks') {
        snapshots.push(url);
      }
    },
    post: async (url) => {
      calls.push(url);

      if (url === '/api/tasks/1101/resume') {
        await pending;
      }
      if (url === '/api/tasks/1102/resume') {
        throw new Error('Отказ запуска');
      }

      return { ok: true };
    },
  });

  globalThis.__pipelineFiltersAlertDialog = async (message) => alerts.push(message);

  await chooseBulk(wrapper, 'resume', 'all');

  const triggers = wrapper.findAll('.pipeline-run-controls button');

  assert.ok(triggers.every((button) => button.element.disabled));

  await triggers[0].trigger('click');
  await triggers[1].trigger('click');

  assert.deepEqual(calls, ['/api/tasks/1101/resume']);

  releaseFirst();
  await flushPromises();
  await flushPromises();

  assert.deepEqual(calls, [
    '/api/tasks/1101/resume',
    '/api/tasks/1102/resume',
    '/api/tasks/1110/resume',
  ]);
  assert.equal(snapshots.length, 2);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /#1102: Отказ запуска/u);
  assert.ok(wrapper.findAll('.pipeline-run-controls button').every((button) => !button.element.disabled));
});

test('пакет пропускает уже запущенную задачу и сменившуюся попытку после SSE', async (t) => {
  const fixtures = structuredClone(BULK_FIXTURE);
  const calls = [];
  let releaseFirst;
  const pending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const { wrapper, flushPromises } = await mountPipeline(t, {
    fixtures,
    post: async (url) => {
      calls.push(url);
      await pending;

      return { ok: true };
    },
  });

  t.after(() => releaseFirst());
  await chooseBulk(wrapper, 'resume', 'all');

  fixtures.find((task) => task.task === 1102).daemonAlive = true;
  fixtures.find((task) => task.task === 1110).attempt = 'replacement';
  globalThis.__pipelineFiltersSseHandler('state-change');
  await new Promise((resolve) => setTimeout(resolve, 900));
  await flushPromises();
  releaseFirst();
  await flushPromises();

  assert.deepEqual(calls, ['/api/tasks/1101/resume']);
});

test('телефон: выбор проекта и состояния использует общие фильтры и сохраняет их', async (t) => {
  const { wrapper, flushPromises } = await mountPipeline(t, { width: 390 });
  const project = wrapper.get('button[data-role="pipeline-phone-project"]');
  const status = wrapper.get('button[data-role="pipeline-phone-status"]');

  await project.trigger('click');
  await flushPromises();
  await wrapper.findAll('[role="option"]').find((option) => option.text().includes('beta')).trigger('click');
  await flushPromises();

  assert.equal(localStorage.getItem('grigdesk-pipeline-project'), 'beta');
  assert.equal(wrapper.findAll('.card').length, 1);
  assert.equal(project.get('.phone-toolbar__label').text(), 'beta');
  assert.equal(project.get('.phone-toolbar__count').text(), '1');
  assert.equal(status.get('.phone-toolbar__label').text(), 'Все');
  assert.equal(status.get('.phone-toolbar__count').text(), '1');
  assert.equal(wrapper.get('[data-phone-controls]').attributes('aria-label'), 'Управление');

  await status.trigger('click');
  await flushPromises();
  await wrapper.findAll('[role="option"]')
    .find((option) => option.text().includes('Ждут решения')).trigger('click');
  await flushPromises();

  assert.equal(localStorage.getItem('grigdesk-pipeline-status'), 'waiting');
  assert.equal(status.get('.phone-toolbar__label').text(), 'Ждут решения');
  assert.equal(status.get('.phone-toolbar__count').text(), '0');
  assert.equal(status.attributes('data-filtered'), 'true');
  assert.equal(wrapper.find('.filter-empty').exists(), true);
});

test('телефон: настройки вида управляют прежними карточками и закрываются при расширении', async (t) => {
  const { wrapper, flushPromises, browser } = await mountPipeline(t, { width: 390 });

  await wrapper.get('[data-phone-controls]').trigger('click');
  await wrapper.get('[data-role="pipeline-phone-compact"]').trigger('click');
  await flushPromises();

  assert.equal(localStorage.getItem('grigdesk-compact'), '0');
  assert.equal(wrapper.get('.card').classes().includes('collapsed'), false);
  assert.equal(wrapper.get('[data-role="pipeline-phone-loops"]').attributes('disabled'), undefined);

  await wrapper.get('[data-role="pipeline-phone-loops"]').trigger('click');
  await flushPromises();

  assert.equal(
    wrapper.get('.compact-view-controls [data-option="loops"]').attributes('aria-pressed'),
    'true',
  );

  browser.happyDOM.setWindowSize({ width: 1024, height: 844 });
  await flushPromises();

  assert.equal(wrapper.find('.phone-toolbar').exists(), false);
  assert.equal(wrapper.find('[data-role="pipeline-phone-loops"]').exists(), false);
  assert.equal(
    wrapper.get('.compact-view-controls [data-option="compact"]').attributes('aria-pressed'),
    'false',
  );
});

test('телефон: массовая команда сохраняет область проекта и блокировку повтора', async (t) => {
  const calls = [];
  const { wrapper, flushPromises } = await mountPipeline(t, {
    width: 320,
    project: 'alpha',
    fixtures: BULK_FIXTURE,
    post: async (url) => {
      calls.push(url);

      return { ok: true };
    },
  });

  await wrapper.get('[data-phone-controls]').trigger('click');

  const command = wrapper.get('[data-phone-bulk-action="stop"][data-bulk-scope="project"]');

  assert.match(command.text(), /Остановить все во вкладке1/u);

  await command.trigger('click');
  await command.trigger('click');
  await flushPromises();
  await flushPromises();

  assert.deepEqual(calls, ['/api/tasks/1103/stop']);
});
