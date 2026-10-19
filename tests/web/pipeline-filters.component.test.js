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

async function mountPipeline(t, { project = 'all', status = 'all' } = {}) {
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
    async get(url) {
      if (url === '/api/tasks') {
        return {
          silenceWindow: 0,
          tasks: FIXTURE.map(({ graph, ...task }) => ({ ...task, readOnly: false })),
        };
      }

      const graphMatch = /^\/api\/tasks\/(\d+)\/graph$/.exec(url);
      if (graphMatch) {
        return FIXTURE.find((task) => String(task.task) === graphMatch[1]).graph;
      }

      return { runners: [] };
    },
    async post() { return { ok: true }; },
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
  return { wrapper, flushPromises };
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

  assert.equal(groups.length, 2);
  assert.equal(groups[0], 'project-strip');
  assert.equal(groups[1], 'toolbar-secondary');
  assert.equal(toolbar.find('.secondary-status-filters').exists(), true);
  assert.deepEqual(options.map((button) => button.attributes('data-option')), ['loops', 'compact']);
  assert.ok(options.every((button) => button.attributes('data-variant') === 'ghost'));
  assert.ok(options.every((button) => button.attributes('aria-label')));
  assert.ok(options.every((button) => button.text().trim() === ''));
  assert.match(
    style,
    /\.toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/su,
  );
  assert.match(
    style,
    /\.toolbar\s*\{[^}]*top:\s*calc\(var\(--pipeline-content-gutter\) \* -1\);/su,
  );
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
