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
    reasonText: 'Жду оценку',
    state: 'neutral',
    message: '',
    ...overrides,
  };
}

async function mountPanel(t, rows) {
  const browser = await installBrowser(t);
  const [{ mount }, { reactive }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  const calls = { opened: [], removed: [] };
  globalThis.__taskShelfPanel = reactive({
    shelf: {
      rows,
      loading: false,
      loaded: true,
      error: null,
      async remove(id) { calls.removed.push(String(id)); },
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

test('Нейтральная строка панели показывает задачу и причину ожидания', async (t) => {
  const { wrapper } = await mountPanel(t, [row()]);
  const item = wrapper.get('[data-task-id="42"]');

  assert.deepEqual({
    text: item.text(),
    state: item.attributes('data-shelf-state'),
  }, {
    text: 'Проверить поставку Жду оценку',
    state: 'neutral',
  });
});

test('Наступившее событие зажигает строку и называет причину', async (t) => {
  const { wrapper } = await mountPanel(t, [row({
    state: 'lit',
    message: 'Оценка готова',
  })]);
  const item = wrapper.get('[data-task-id="42"]');

  assert.deepEqual({
    text: item.text(),
    state: item.attributes('data-shelf-state'),
  }, {
    text: 'Проверить поставку Жду оценку Оценка готова',
    state: 'lit',
  });
});

test('Клик строки открывает карточку и не удаляет запись', async (t) => {
  const { wrapper, calls } = await mountPanel(t, [row()]);
  await wrapper.get('[data-task-id="42"]').trigger('click');

  assert.deepEqual(calls, { opened: ['42'], removed: [] });
});

test('Крестик удаляет запись явно и не открывает карточку', async (t) => {
  const { wrapper, calls } = await mountPanel(t, [row()]);
  await wrapper.get('[data-task-id="42"] button[aria-label="Убрать с полки"]').trigger('click');

  assert.deepEqual(calls, { opened: [], removed: ['42'] });
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
