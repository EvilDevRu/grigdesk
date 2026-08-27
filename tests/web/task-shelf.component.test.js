import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
        '../../stores/task-shelf.js': [
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
    footer: item.get('.shelf-footer').text(),
    state: item.attributes('data-shelf-state'),
  }, {
    id: '#42',
    project: 'Кокпит',
    title: 'Проверить поставку',
    waiting: 'Ожидание Жду оценку',
    activities: ['Битрикс24В работе', 'ОценкаВ очереди'],
    footer: 'Иван Петров до 29.08.20262 непрочитанных',
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

test('Широкая полка остаётся единым реестром без прыгающих карточных колонок', async () => {
  const source = await readFile(webFile('src/views/shelf/TaskShelfPanel.vue'), 'utf8');
  const wideListPattern = [
    String.raw`@container task-shelf \(min-width: 820px\)`,
    String.raw`[\s\S]*?\.shelf-list\s*\{\s*`,
    String.raw`grid-template-columns:\s*minmax\(0, 1fr\);`,
  ].join('');

  assert.match(source, new RegExp(wideListPattern));
  assert.doesNotMatch(
    source,
    /@container task-shelf \(min-width: 820px\)[\s\S]*?grid-template-columns:\s*repeat\(2,/,
  );
  assert.match(source, /grid-template-areas:[\s\S]*?'meta meta signal'/);
  assert.match(source, /'activities activities activities'[\s\S]*?'footer footer footer';/);
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
    setRuntime() {},
    toggleExpanded() {},
    setExpanded(value) { this.isExpanded = value; },
    consume() {},
  };
}

async function mountToolHost(t, { totalCount, litCount }) {
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
    shelf: { totalCount, litCount },
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
        '../../stores/task-shelf.js': [
          'export const useTaskShelfStore = () => globalThis.__taskShelfHost.shelf;',
        ].join('\n'),
        '../../composables/useUiContextSource.js': [
          'export const useUiContextSource = () => ({ focus() {}, update() {}, blur() {} });',
        ].join('\n'),
        '../tools/viewport.js': [
          'import { ref } from "vue";',
          'export const useDockViewport = () => ({ dockCapable: ref(true) });',
        ].join('\n'),
        '../tools/registry.js': [
          'const component = { template: "<div></div>" };',
          'export const TOOL_REGISTRY = [{',
          '  id: "shelf", route: "/shelf", label: "Полка", icon: "shelf",',
          '  plugin: "shelf", component,',
          '}];',
          'export const TOOL_BY_ID = new Map(TOOL_REGISTRY.map((item) => [item.id, item]));',
          'export const toolAvailability = (item, plugins) =>',
          '  item && plugins.enabled(item.plugin) ? "enabled" : "disabled";',
        ].join('\n'),
        './ToolDock.vue': 'export default { template: "<section><slot /></section>" };',
        '../../ui': [
          'export const UiIconButton = {',
          '  inheritAttrs: false, props: ["title", "label", "pressed"],',
          '  template: `<button v-bind="$attrs" :title="title"><slot /></button>`,',
          '};',
          'export const useUiLayer = () => {};',
        ].join('\n'),
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

test('Закрытый док показывает нейтральный чип с общим числом записей', async (t) => {
  const wrapper = await mountToolHost(t, { totalCount: 3, litCount: 0 });
  const badge = wrapper.get('button[title="Полка"] .tool-badge');

  assert.deepEqual({ text: badge.text(), wait: badge.classes().includes('wait') }, {
    text: '3',
    wait: false,
  });
});

test('Закрытый док показывает жёлтый пульсирующий чип с числом огней', async (t) => {
  const wrapper = await mountToolHost(t, { totalCount: 3, litCount: 2 });
  const badge = wrapper.get('button[title="Полка"] .tool-badge');

  assert.deepEqual({
    text: badge.text(),
    wait: badge.classes().includes('wait'),
    pulse: badge.classes().includes('pulse'),
  }, {
    text: '2',
    wait: true,
    pulse: true,
  });
});
