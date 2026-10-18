import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

async function browserHarness() {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/settings' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    KeyboardEvent: browser.KeyboardEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  return browser;
}

// Карточка проверяется с живым store: подменяются только плагины, иначе она потянула
// бы за собой сеть, а предмет проверки — именно запись сочетания и отказ от неё.
async function mountCard(t) {
  const browser = await browserHarness();
  const [{ nextTick }, { mount }, { createPinia, setActivePinia }, Card, storeModule] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    compileVue(webFile('src/views/settings/ToolHotkeys.vue'), {
      stubs: {
        '../../stores/plugins.js': [
          'export const usePluginsStore = () => ({ loaded: true, enabled: () => true });',
        ].join('\n'),
      },
    }),
    import('../../web/src/stores/hotkeys.js'),
  ]);
  setActivePinia(createPinia());
  const hotkeys = storeModule.useHotkeysStore();
  const wrapper = mount(Card, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    browser.close();
  });

  const press = async (init) => {
    browser.window.dispatchEvent(new browser.KeyboardEvent('keydown', { ...init, bubbles: true }));
    await nextTick();
  };
  const comboText = (id) => wrapper.get(`[data-testid="hotkey-combo-${id}"]`).text();

  return { wrapper, hotkeys, press, comboText };
}

test('запись сочетания отказывает системной комбинации и не трогает прежнюю клавишу', async (t) => {
  const { wrapper, hotkeys, press, comboText } = await mountCard(t);

  assert.equal(comboText('code'), 'Ctrl + Shift + 1');

  await wrapper.get('[data-testid="hotkey-record-code"]').trigger('click');
  assert.equal(hotkeys.recording, 'code');
  assert.equal(comboText('code'), 'Нажмите сочетание…');

  await press({ code: 'ShiftLeft', key: 'Shift', shiftKey: true });
  assert.equal(hotkeys.recording, 'code', 'один модификатор ещё не сочетание');

  await press({ code: 'ShiftLeft', key: 'GroupNext', altKey: true });
  assert.match(
    wrapper.get('[data-testid="hotkey-error"]').text(),
    /раскладк/i,
    'перехваченную переключателем раскладки клавишу нельзя просто проглотить',
  );
  assert.equal(hotkeys.recording, 'code', 'после подсказки запись продолжается');

  await press({ code: 'KeyW', key: 'w', ctrlKey: true });
  assert.match(wrapper.get('[data-testid="hotkey-error"]').text(), /вкладк/i);
  assert.equal(hotkeys.recording, 'code', 'после отказа окно записи остаётся открытым');
  assert.equal(hotkeys.comboOf('code'), 'Ctrl+Shift+Digit1');

  await press({ code: 'KeyK', key: 'л', ctrlKey: true, altKey: true });
  assert.equal(hotkeys.recording, null);
  assert.equal(comboText('code'), 'Ctrl + Alt + K', 'русская раскладка не мешает записи');
  assert.deepEqual(JSON.parse(localStorage.getItem('grigdesk-tool-hotkeys')), {
    code: 'Ctrl+Alt+KeyK',
  });
  assert.equal(wrapper.find('[data-testid="hotkey-error"]').exists(), false);
});

test('Escape отменяет запись, а выключенную клавишу можно вернуть к умолчанию', async (t) => {
  const { wrapper, hotkeys, press, comboText } = await mountCard(t);

  await wrapper.get('[data-testid="hotkey-record-terminal"]').trigger('click');
  await press({ code: 'Escape', key: 'Escape' });
  assert.equal(hotkeys.recording, null);
  assert.equal(comboText('terminal'), 'Ctrl + Shift + 3', 'отмена не меняет сочетание');

  await wrapper.get('[data-testid="hotkey-secondary-terminal"]').trigger('click');
  assert.equal(comboText('terminal'), 'выключено');
  assert.equal(hotkeys.comboOf('terminal'), '');

  await wrapper.get('[data-testid="hotkey-secondary-terminal"]').trigger('click');
  assert.equal(comboText('terminal'), 'Ctrl + Shift + 3');

  await wrapper.get('[data-testid="hotkey-record-code"]').trigger('click');
  await press({ code: 'Digit9', key: '9', ctrlKey: true, shiftKey: true });
  assert.equal(hotkeys.comboOf('code'), 'Ctrl+Shift+Digit9');

  await wrapper.get('[data-testid="hotkey-reset-all"]').trigger('click');
  assert.equal(comboText('code'), 'Ctrl + Shift + 1', 'общий сброс возвращает заводские клавиши');
});

// Фиктивный док повторяет только контракт, который трогает ToolHost: чем меньше
// в тесте настоящего состояния, тем честнее проверяется сама реакция на клавишу.
function hostDock() {
  return {
    activeTool: null,
    isOpen: false,
    isExpanded: false,
    width: 560,
    mounted: {},
    runtime: {},
    intents: {},
    open(id) {
      this.activeTool = id;
      this.isOpen = true;
      this.mounted[id] = true;
    },
    close() { this.isOpen = false; },
    setMounted(id, value) { this.mounted[id] = value; },
    resetRuntime(id) { delete this.mounted[id]; },
    resetAllRuntime() {},
    rememberTool(id) { this.activeTool = id; },
    setWidth() {},
    fitWidth() {},
    setRuntime() {},
    toggleExpanded() {},
    setExpanded() {},
    consume() {},
  };
}

async function mountHost(t) {
  const browser = await browserHarness();
  browser.innerWidth = 1200;
  const [{ nextTick, reactive }, { mount }, { createPinia, setActivePinia }, storeModule] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/src/stores/hotkeys.js'),
  ]);
  const state = reactive({
    dock: hostDock(),
    plugins: {
      loaded: true,
      list: [{ id: 'code', enabled: true, nav: { group: 'dock' } }],
      dockNav: [{ id: 'code' }],
      enabled: (id) => id === 'code',
    },
  });
  globalThis.__hotkeyHost = state;
  const ToolHost = await compileVue(webFile('src/shared/layout/ToolHost.vue'), {
    stubs: {
      'vue-router': [
        'export const useRoute = () => ({ path: "/board", meta: {} });',
        'export const useRouter = () => ({ async push() {} });',
      ].join('\n'),
      '../../stores/dock.js': [
        'export const MIN_DOCK_WIDTH = 380;',
        'export const useDockStore = () => globalThis.__hotkeyHost.dock;',
      ].join('\n'),
      '../../stores/plugins.js': [
        'export const usePluginsStore = () => globalThis.__hotkeyHost.plugins;',
      ].join('\n'),
      '../../stores/taskShelf.ts': [
        'export const useTaskShelfStore = () => ({ totalCount: 0, litCount: 0 });',
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
        'export const TOOL_REGISTRY = [',
        '  { id: "code", route: "/code", label: "Код", icon: "code", plugin: "code", component },',
        '  { id: "terminal", route: "/terminal", label: "Терминал", icon: "terminal", component },',
        '];',
        'export const TOOL_BY_ID = new Map(TOOL_REGISTRY.map((item) => [item.id, item]));',
        'export const toolsOf = () => TOOL_REGISTRY;',
        'export const toolById = (plugins, id) => TOOL_BY_ID.get(id) || null;',
        'export const toolAvailability = (item, plugins) =>',
        '  !item ? "disabled" : (!item.plugin || plugins.enabled(item.plugin) ? "enabled" : "disabled");',
      ].join('\n'),
      './ToolDock.vue': 'export default { template: "<section><slot /></section>" };',
      '../../ui': ([
        'export const UiIconButton = {',
        '  inheritAttrs: false, props: ["title", "label", "pressed"],',
        '  template: `<button v-bind="$attrs" :title="title"><slot /></button>`,',
        '};',
        'export const useUiLayer = () => {};',
      ].join('\n')) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
    },
  });
  setActivePinia(createPinia());
  const hotkeys = storeModule.useHotkeysStore();
  const wrapper = mount(ToolHost, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    delete globalThis.__hotkeyHost;
  });

  const press = async (init) => {
    browser.document.body.dispatchEvent(
      new browser.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }),
    );
    await nextTick();
  };

  return { wrapper, dock: state.dock, hotkeys, press };
}

test('клавиша открывает и закрывает панель, а во время записи слушатель молчит', async (t) => {
  const { wrapper, dock, hotkeys, press } = await mountHost(t);

  await press({ code: 'Digit3', key: '3', ctrlKey: true, shiftKey: true });
  assert.deepEqual({ tool: dock.activeTool, open: dock.isOpen }, { tool: 'terminal', open: true });

  await press({ code: 'Digit3', key: '3', ctrlKey: true, shiftKey: true });
  assert.equal(dock.isOpen, false, 'повторное нажатие закрывает ту же панель');

  await press({ code: 'Digit2', key: '2', ctrlKey: true, shiftKey: true });
  assert.equal(dock.isOpen, false, 'у панели вне рейки клавиши нет');

  hotkeys.startRecording('code');
  await press({ code: 'Digit3', key: '3', ctrlKey: true, shiftKey: true });
  assert.equal(dock.isOpen, false, 'настройка сочетания не должна открывать панель');
  hotkeys.stopRecording();

  await press({ code: 'Digit1', key: '1', ctrlKey: true, shiftKey: true });
  assert.deepEqual({ tool: dock.activeTool, open: dock.isOpen }, { tool: 'code', open: true });
  assert.match(
    wrapper.get('button[data-ui-tooltip^="Код"]').attributes('data-ui-tooltip'),
    /Ctrl \+ Shift \+ 1/,
  );
});
