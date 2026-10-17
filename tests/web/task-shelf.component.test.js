import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installBrowser } from './helpers/board-view.js';

process.env.NODE_ENV = 'test';

let nonce = 0;

function row(overrides = {}) {
  return {
    taskId: '42',
    title: 'Проверить поставку',
    addedAt: new Date().toISOString(),
    reasonText: 'Жду оценку',
    state: 'neutral',
    completed: false,
    message: '',
    source: null,
    details: {
      project: 'Кокпит',
      responsible: 'Иван Петров',
      deadline: '29.08.2026',
      overdue: false,
      unread: 2,
      activities: [
        { kind: 'b24', label: 'Битрикс24', value: 'В работе', tone: 'accent' },
        { kind: 'analysis', label: 'Оценка', value: 'В очереди', tone: 'neutral' },
      ],
    },
    ...overrides,
  };
}

async function mountPanel(t, rows, { error = null } = {}) {
  const browser = await installBrowser(t);
  const [{ mount }, { reactive }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  const calls = { opened: [], acknowledged: [], removed: [] };
  globalThis.__taskShelfPanel = reactive({
    shelf: {
      rows,
      loading: false,
      loaded: true,
      error,
      async remove(id) { calls.removed.push(String(id)); },
      async acknowledge(id) { calls.acknowledged.push(String(id)); },
      isPending() { return false; },
    },
    ui: { openTask(id) { calls.opened.push(String(id)); } },
  });
  let Panel;
  try {
    Panel = await compileVue(webFile('src/views/shelf/TaskShelfPanel.vue'), {
      stubs: {
        '../../stores/taskShelf.ts': [
          'export const useTaskShelfStore = () => globalThis.__taskShelfPanel.shelf;',
        ].join('\n'),
        '../../stores/ui.js': [
          'export const useUiStore = () => globalThis.__taskShelfPanel.ui;',
        ].join('\n'),
      },
    });
  } catch (error) {
    assert.fail(`Панель полки ещё не реализована или не монтируется: ${error.message}`);
  }
  const wrapper = mount(Panel, {
    attachTo: browser.document.querySelector('#mount'),
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__taskShelfPanel;
  });
  return { wrapper, calls };
}

test('Нейтральная карточка показывает задачу, ожидание и живые метаданные', async (t) => {
  const { wrapper } = await mountPanel(t, [row()]);
  const item = wrapper.get('[data-task-id="42"]');

  assert.deepEqual({
    id: item.get('.shelf-id').text(),
    project: item.get('.shelf-project').text(),
    title: item.get('.shelf-title').text(),
    waiting: item.get('.shelf-waiting').text(),
    activities: item.findAll('.shelf-activity').map((activity) => activity.text()),
    responsible: item.get('.shelf-responsible').text(),
    deadline: item.get('.shelf-deadline').text(),
    unread: item.get('.shelf-unread').text(),
    age: item.get('time').text(),
    state: item.attributes('data-shelf-state'),
  }, {
    id: '#42',
    project: 'Кокпит',
    title: 'Проверить поставку',
    waiting: 'Ожидание Жду оценку',
    activities: ['Битрикс24: В работе', 'Оценка: В очереди'],
    responsible: 'Ответственный: Иван Петров',
    deadline: 'до 29.08.2026',
    unread: ', 2 непрочитанных',
    age: 'добавлена сегодня',
    state: 'neutral',
  });
});

test('Наступившее событие зажигает строку и называет причину', async (t) => {
  const { wrapper } = await mountPanel(t, [row({
    state: 'lit',
    source: 'analysis',
    message: 'Оценка готова',
  })]);
  const item = wrapper.get('[data-task-id="42"]');

  assert.deepEqual({
    event: item.get('.shelf-event').text(),
    state: item.attributes('data-shelf-state'),
  }, {
    event: 'Новое событие · оценкаОценка готоваОткрытие задачи отметит событие просмотренным',
    state: 'lit',
  });
});

test('Клик строки открывает карточку и не удаляет запись', async (t) => {
  const { wrapper, calls } = await mountPanel(t, [row()]);
  await wrapper.get('[data-task-id="42"] .ui-selectable-row__primary').trigger('click');

  assert.deepEqual(calls, { opened: ['42'], acknowledged: [], removed: [] });
});

test('Крестик удаляет запись явно и не открывает карточку', async (t) => {
  const { wrapper, calls } = await mountPanel(t, [row()]);
  await wrapper.get('[data-task-id="42"] button[aria-label="Убрать с полки"]').trigger('click');

  assert.deepEqual(calls, { opened: [], acknowledged: [], removed: ['42'] });
});

test('Галочка гасит событие, не открывая и не удаляя задачу', async (t) => {
  const { wrapper, calls } = await mountPanel(t, [row({
    state: 'lit',
    source: 'pipeline',
    message: 'Конвейер ждёт решения',
  })]);
  await wrapper.get('button[aria-label="Отметить событие просмотренным"]').trigger('click');

  assert.deepEqual(calls, { opened: [], acknowledged: ['42'], removed: [] });
});

test('События собраны перед обычным ожиданием независимо от порядка стора', async (t) => {
  const waiting = row({ taskId: '11', title: 'Ждущая задача' });
  const attention = row({
    taskId: '22',
    title: 'Нужна реакция',
    state: 'lit',
    message: 'Пришёл ответ',
  });
  const { wrapper } = await mountPanel(t, [waiting, attention]);

  assert.deepEqual({
    groups: wrapper.findAll('.shelf-group').map((group) => group.attributes('data-shelf-group')),
    attention: wrapper.get('[data-shelf-group="attention"] [data-task-id]').attributes('data-task-id'),
    waiting: wrapper.get('[data-shelf-group="waiting"] [data-task-id]').attributes('data-task-id'),
  }, {
    groups: ['attention', 'waiting'],
    attention: '22',
    waiting: '11',
  });
});

test('Завершённые задачи собраны внизу и показаны приглушёнными', async (t) => {
  const completed = row({
    taskId: '33',
    title: 'Завершённая задача',
    state: 'lit',
    completed: true,
    source: 'b24',
    message: 'Задача завершена или закрыта',
  });
  const waiting = row({ taskId: '11', title: 'Ждущая задача' });
  const attention = row({
    taskId: '22',
    title: 'Нужна реакция',
    state: 'lit',
    message: 'Пришёл ответ',
  });
  const { wrapper } = await mountPanel(t, [completed, waiting, attention]);
  const completedCard = wrapper.get('[data-shelf-group="completed"] [data-task-id="33"]');

  assert.deepEqual({
    groups: wrapper.findAll('.shelf-group').map((group) => group.attributes('data-shelf-group')),
    title: completedCard.get('.shelf-title').text(),
    muted: completedCard.attributes('data-shelf-completed'),
  }, {
    groups: ['attention', 'waiting', 'completed'],
    title: 'Завершённая задача',
    muted: 'true',
  });
});

test('Поиск объединяет номер, название, проект и ответственного без мутаций полки', async (t) => {
  const { wrapper, calls } = await mountPanel(t, [
    row({ title: 'Проверить расчёт' }),
    row({ taskId: '77', title: 'Другая задача' }),
  ]);

  await wrapper.get('input[type="search"]').setValue(' #42  РАСЧЕТ кокпит ПЕТРОВ ');

  assert.deepEqual(
    wrapper.findAll('[data-task-id]').map((item) => item.attributes('data-task-id')),
    ['42'],
  );
  assert.equal(wrapper.get('.shelf-filter-summary [role="status"]').text(), 'Показано 1 из 2');
  assert.equal(wrapper.get('[data-shelf-filter="all"]').text(), 'Все · 2');
  assert.deepEqual(calls, { opened: [], acknowledged: [], removed: [] });

  await wrapper.get('button[aria-label="Очистить поиск"]').trigger('click');

  assert.equal(wrapper.findAll('[data-task-id]').length, 2);
  assert.equal(wrapper.find('.shelf-filter-summary').exists(), false);
});

test('Фильтр внимания учитывает просмотренные остановки и применяется вместе с поиском', async (t) => {
  const { wrapper } = await mountPanel(t, [
    row({ taskId: '11' }),
    row({ taskId: '22', title: 'Проверить план', needsHuman: true }),
    row({ taskId: '33', state: 'lit', message: 'Пришёл ответ' }),
    row({ taskId: '44', completed: true, state: 'lit' }),
  ]);

  assert.equal(wrapper.get('.shelf-heading p').text(), '4 задачи · требуют внимания: 2');
  await wrapper.get('[data-shelf-filter="attention"]').trigger('click');

  assert.deepEqual(
    wrapper.findAll('[data-task-id]').map((item) => item.attributes('data-task-id')),
    ['22', '33'],
  );
  assert.equal(wrapper.get('[data-shelf-filter="attention"]').attributes('aria-pressed'), 'true');
  assert.match(wrapper.get('[data-task-id="22"] .shelf-waiting').text(), /Требует внимания/);

  await wrapper.get('input[type="search"]').setValue('план');

  assert.equal(wrapper.findAll('[data-task-id]').length, 1);
  assert.equal(wrapper.get('[data-task-id]').attributes('data-task-id'), '22');
  assert.equal(wrapper.get('[data-shelf-filter="attention"]').text(), 'Внимание · 2');
});

test('Пустой результат отличается от пустой полки и позволяет сбросить оба фильтра', async (t) => {
  const { wrapper } = await mountPanel(t, [row()]);

  await wrapper.get('[data-shelf-filter="completed"]').trigger('click');
  await wrapper.get('input[type="search"]').setValue('несуществующая задача');

  assert.equal(wrapper.get('.shelf-empty h3').text(), 'Ничего не найдено');
  assert.equal(wrapper.get('.shelf-filter-summary [role="status"]').text(), 'Показано 0 из 1');
  await wrapper.get('.shelf-filter-summary button').trigger('click');

  assert.equal(wrapper.get('input').element.value, '');
  assert.equal(wrapper.element.ownerDocument.activeElement === wrapper.get('input').element, true);
  assert.equal(wrapper.get('[data-shelf-filter="all"]').attributes('aria-pressed'), 'true');
  assert.equal(wrapper.findAll('[data-task-id]').length, 1);
});

test('Новые данные обновляют выбранную группу и её счётчик без сброса поиска', async (t) => {
  const { wrapper } = await mountPanel(t, [row({ needsHuman: true })]);

  await wrapper.get('[data-shelf-filter="attention"]').trigger('click');
  await wrapper.get('input[type="search"]').setValue('поставку');
  globalThis.__taskShelfPanel.shelf.rows[0].needsHuman = false;
  await wrapper.vm.$nextTick();

  assert.equal(wrapper.findAll('[data-task-id]').length, 0);
  assert.equal(wrapper.get('[data-shelf-filter="attention"]').text(), 'Внимание · 0');
  assert.equal(wrapper.get('[data-shelf-filter="attention"]').attributes('aria-pressed'), 'true');
  assert.equal(wrapper.get('input').element.value, 'поставку');

  globalThis.__taskShelfPanel.shelf.rows.push(row({ taskId: '77', needsHuman: true }));
  await wrapper.vm.$nextTick();

  assert.equal(wrapper.get('[data-task-id]').attributes('data-task-id'), '77');
  assert.equal(wrapper.get('[data-shelf-filter="attention"]').text(), 'Внимание · 1');
});

test('Ошибка обновления не скрывает уже загруженные задачи', async (t) => {
  const { wrapper } = await mountPanel(t, [row()], {
    error: 'Не удалось обновить полку',
  });

  assert.deepEqual({
    alert: wrapper.get('[role="alert"]').text(),
    task: wrapper.get('[data-task-id="42"] .shelf-title').text(),
  }, {
    alert: 'Не удалось обновить полку',
    task: 'Проверить поставку',
  });
});

function pipelineRow(activity) {
  const base = row();

  return { ...base, details: { ...base.details, activities: [activity] } };
}

test('Задача на конвейере получает видимую полосу прогона в тоне состояния', async (t) => {
  const { wrapper } = await mountPanel(t, [pipelineRow({
    kind: 'pipeline',
    label: 'Конвейер',
    value: '3/7 · Проверка',
    tone: 'accent',
    progress: { done: 3, total: 7 },
  })]);
  const bar = wrapper.get('[data-task-id="42"] [role="progressbar"]');

  assert.deepEqual({
    tone: bar.classes().filter((name) => name.startsWith('ui-progress--')),
    now: bar.attributes('aria-valuenow'),
    max: bar.attributes('aria-valuemax'),
    text: bar.attributes('aria-valuetext'),
    width: Math.round(parseFloat(bar.get('.ui-progress__bar').element.style.width)),
  }, {
    tone: ['ui-progress--accent'],
    now: '3',
    max: '7',
    text: '3/7',
    width: 43,
  });
});

test('Остановка на человеке красит полосу тревогой, а прогон без цифр только движется', async (t) => {
  const { wrapper } = await mountPanel(t, [pipelineRow({
    kind: 'pipeline',
    label: 'Конвейер',
    value: 'Нужно решение · Подтвердить план',
    tone: 'warn',
    progress: { done: 0, total: 0 },
  })]);
  const bar = wrapper.get('[data-task-id="42"] [role="progressbar"]');

  assert.deepEqual({
    tone: bar.classes().filter((name) => name.startsWith('ui-progress--')),
    now: bar.attributes('aria-valuenow'),
    text: bar.attributes('aria-valuetext'),
    indeterminate: bar.get('.ui-progress__bar').classes().includes('is-indeterminate'),
  }, {
    tone: ['ui-progress--warning'],
    now: undefined,
    text: 'Идёт',
    indeterminate: true,
  });
});

test('Задача, которую держат ворота, остаётся сверху и без огонька', async (t) => {
  // Огонёк снимается первым же acknowledge, а открытые ворота никуда не деваются:
  // такая задача обязана остаться в верхней группе, а не уехать в «В ожидании».
  const gated = row({ taskId: '77', title: 'Ждёт решения', needsHuman: true });
  const plain = row({ taskId: '11', title: 'Просто ждёт' });
  const { wrapper } = await mountPanel(t, [plain, gated]);

  assert.deepEqual({
    groups: wrapper.findAll('.shelf-group').map((group) => group.attributes('data-shelf-group')),
    attention: wrapper.get('[data-shelf-group="attention"] [data-task-id]').attributes('data-task-id'),
    waiting: wrapper.get('[data-shelf-group="waiting"] [data-task-id]').attributes('data-task-id'),
  }, {
    groups: ['attention', 'waiting'],
    attention: '77',
    waiting: '11',
  });
});

test('Полоса прогона идёт с числом рядом, а не одной залитой долей', async (t) => {
  // На воротах текст плашки занимает название решения, и цифры в нём нет: без
  // отдельной подписи полоса оставалась залитой долей без единого числа.
  const { wrapper } = await mountPanel(t, [pipelineRow({
    kind: 'pipeline',
    label: 'Конвейер',
    value: 'Нужно решение · принять работу',
    tone: 'warn',
    progress: { done: 6, total: 7 },
  })]);
  const progress = wrapper.get('[data-task-id="42"] .shelf-progress');

  assert.deepEqual({
    count: progress.get('.shelf-progress-count').text(),
    tone: progress.attributes('data-tone'),
    insideActivity: wrapper.findAll('.shelf-activity .ui-progress').length,
  }, {
    count: 'Конвейер, пройдено: 6/7',
    tone: 'warn',
    insideActivity: 0,
  });
});

test('Карточка без живого прогона полосу не показывает', async (t) => {
  const { wrapper } = await mountPanel(t, [pipelineRow({
    kind: 'pipeline',
    label: 'Конвейер',
    value: 'Последний прогон сейчас не виден',
    tone: 'neutral',
  })]);

  assert.deepEqual({
    bars: wrapper.findAll('[role="progressbar"]').length,
    activity: wrapper.get('[data-task-id="42"] .shelf-activity').text(),
  }, {
    bars: 0,
    activity: 'Конвейер: Последний прогон сейчас не виден',
  });
});

function hostDock() {
  return {
    activeTool: 'shelf',
    isOpen: false,
    isExpanded: false,
    width: 560,
    mounted: {},
    runtime: {},
    intents: {},
    open(id) { this.activeTool = id; this.isOpen = true; },
    close() { this.isOpen = false; },
    setMounted(id, value) { this.mounted[id] = value; },
    resetRuntime(id) { delete this.mounted[id]; delete this.runtime[id]; },
    resetAllRuntime() {},
    rememberTool(id) { this.activeTool = id; },
    setWidth() {},
    fitWidth() {},
    setRuntime() {},
    toggleExpanded() {},
    setExpanded(value) { this.isExpanded = value; },
    consume() {},
  };
}

/**
 * Монтирует настоящий ToolHost с явными строками полки и изолированными сторами.
 * Полнота строк позволяет проверять внимание, не подменяя его готовым числом.
 */
async function mountToolHost(t, rows) {
  const browser = await installBrowser(t);
  browser.innerWidth = 1200;
  const [{ mount }, { reactive }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  const state = reactive({
    dock: hostDock(),
    plugins: {
      loaded: true,
      list: [{ id: 'shelf', enabled: true, nav: { group: 'dock' } }],
      dockNav: [{ id: 'shelf' }],
      enabled: (id) => id === 'shelf',
    },
    shelf: { rows },
  });
  globalThis.__taskShelfHost = state;
  let ToolHost;
  try {
    ToolHost = await compileVue(webFile('src/shared/layout/ToolHost.vue'), {
      stubs: {
        'vue-router': [
          'export const useRoute = () => ({ path: "/board", meta: {} });',
          'export const useRouter = () => ({ async push() {} });',
        ].join('\n'),
        '../../stores/dock.js': [
          'export const MIN_DOCK_WIDTH = 380;',
          'export const useDockStore = () => globalThis.__taskShelfHost.dock;',
        ].join('\n'),
        '../../stores/plugins.js': [
          'export const usePluginsStore = () => globalThis.__taskShelfHost.plugins;',
        ].join('\n'),
        '../../stores/hotkeys.js': [
          'export const useHotkeysStore = () =>',
          '  ({ recording: null, toolByCombo: {}, comboOf: () => "" });',
        ].join('\n'),
        '../../stores/taskShelf.ts': [
          'export const useTaskShelfStore = () => globalThis.__taskShelfHost.shelf;',
        ].join('\n'),
        '../../composables/useUiContextSource.ts': [
          'export const useUiContextSource = () => ({ focus() {}, update() {}, blur() {} });',
        ].join('\n'),
        '../tools/viewport.ts': [
          'import { ref } from "vue";',
          'export const useDockViewport = () => ({ dockCapable: ref(true) });',
        ].join('\n'),
        '../tools/registry.ts': [
          'const component = { template: "<div></div>" };',
          'export const TOOL_REGISTRY = [{',
          '  id: "shelf", route: "/shelf", label: "Полка", icon: "shelf",',
          '  plugin: "shelf", component,',
          '}];',
          'export const TOOL_BY_ID = new Map(TOOL_REGISTRY.map((item) => [item.id, item]));',
          'export const toolsOf = () => TOOL_REGISTRY;',
          'export const toolById = (plugins, id) => TOOL_BY_ID.get(id) || null;',
          'export const toolAvailability = (item, plugins) =>',
          '  item && plugins.enabled(item.plugin) ? "enabled" : "disabled";',
        ].join('\n'),
        './ToolDock.vue': 'export default { template: "<section><slot /></section>" };',
        '../../ui': ([
          'export const UiIconButton = {',
          '  inheritAttrs: false, props: ["title", "label", "pressed"],',
          '  template: `<button v-bind="$attrs" :aria-label="label" :title="title"><slot /></button>`,',
          '};',
          'export const useUiLayer = () => {};',
        ].join('\n')) +
          "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      },
    });
  } catch (error) {
    assert.fail(`Чип полки в ToolHost ещё не реализован или не монтируется: ${error.message}`);
  }
  const wrapper = mount(ToolHost, {
    attachTo: browser.document.querySelector('#mount'),
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__taskShelfHost;
  });
  return wrapper;
}

test('Закрытый док не показывает обычное ожидание и завершённые задачи в счётчике', async (t) => {
  const wrapper = await mountToolHost(t, [row(), row({
    taskId: 'done',
    state: 'lit',
    completed: true,
  })]);

  assert.equal(wrapper.find('.navigation-count').exists(), false);
  assert.equal(wrapper.get('button').attributes('aria-label'), 'Полка');
});

test('Счётчик полки сохраняет просмотренные ожидания решения и полное число в подсказке', async (t) => {
  const rows = [
    row({ taskId: 'event', state: 'lit' }),
    row({ taskId: 'human', needsHuman: true }),
    row({
      taskId: 'both',
      state: 'lit',
      needsHuman: true,
    }),
    row(),
  ];
  const wrapper = await mountToolHost(t, rows);
  const badge = wrapper.get('.navigation-count');

  assert.equal(badge.text(), '3');
  assert.equal(badge.classes().includes('wait'), true);
  assert.match(wrapper.get('button').attributes('data-ui-tooltip'), /Требуют внимания: 3/);
  assert.match(wrapper.get('button').attributes('aria-label'), /ждут решения: 2/);

  globalThis.__taskShelfHost.shelf.rows = Array.from({ length: 1000 }, (_, index) =>
    row({ taskId: String(index), state: 'lit' }));
  await wrapper.vm.$nextTick();

  assert.equal(wrapper.get('.navigation-count').text(), '999+');
  assert.equal(wrapper.get('.navigation-count').classes().includes('info'), true);
  assert.match(wrapper.get('button').attributes('data-ui-tooltip'), /Требуют внимания: 1000/);
  assert.match(wrapper.get('button').attributes('aria-label'), /Требуют внимания: 1000/);
});
