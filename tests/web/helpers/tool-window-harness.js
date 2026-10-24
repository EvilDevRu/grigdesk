import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { compileModule, compileVue, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';
import { desktopUserAgent } from '../../../shared/desktop/desktopWindowContract.ts';

export const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Отсутствие нового продуктового модуля отмечается явным assertion о поведении.
 * Ошибки компиляции существующего файла остаются ошибками фикстуры, их не маскируем.
 */
export async function featureModule(relative) {
  const filename = webFile(relative);
  const present = await access(filename).then(() => true, () => false);

  assert.equal(present, true, `Не реализован оконный контракт: ${relative}`);

  return compileModule(filename);
}

/**
 * Настоящие ToolHost, ToolDock, router и Pinia сохраняют lifecycle документа.
 * Только тяжёлые панели заменены наблюдаемыми компонентами без сети и сеансов владельца.
 */
export async function hostFixture(t, { width = 1280, mode = 'main', windows = true } = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/chats');

  Object.defineProperty(globalThis, 'history', { value: browser.history, configurable: true });

  const vue = await import('../../../web/node_modules/vue/index.mjs');
  const { createPinia, disposePinia, setActivePinia } = await import(
    '../../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const { createRouter, createMemoryHistory } = await import(
    '../../../web/node_modules/vue-router/dist/vue-router.mjs'
  );
  const { mount, flushPromises } = await import(
    '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const pinia = createPinia();
  const mounts = [];
  const unmounts = [];
  const imports = [];
  const contexts = {};
  const ids = ['code', 'shelf', 'ssh', 'db', 'docker', 'terminal', 'studio3d', 'example', 'module-example'];
  const names = ['Код', 'Полка', 'SSH', 'БД', 'Докер', 'Терминал', '3D', 'Пример', 'Модуль'];
  const tools = ids.map((id, index) => ({

    id,

    label: names[index],

    route: ['example', 'module-example'].includes(id) ? '/ext/' + id : '/' + id,

    plugin: id === 'module-example' ? 'module-example' : id === 'example',

    ...(id === 'module-example' ? { detachable: false } : {}),

    component: vue.markRaw(vue.defineComponent({

      props: ['active', 'compact', 'presentation', 'intents'],

      emits: ['context', 'consume-intent'],

      /**
       * Публикует наблюдаемый lifecycle лёгкой панели в настоящем ToolHost.
       * Контекст меняет компонент, не подменный реестр uiContext.
       */
      setup(props, { emit, expose }) {
        vue.onMounted(() => mounts.push(id));
        vue.onBeforeUnmount(() => unmounts.push(id));
        expose({
          focus() { },
          importState(state) {
            imports.push([id, structuredClone(state)]);
          },
        });
        contexts[id] = (value) => emit('context', value);

        return () => vue.h('section', { 'data-panel': id }, props.presentation);
      },

    })),

  }));
  const state = {

    tools,

    plugins: vue.reactive({
      loaded: true,
      nav: [],
      installed: [],
      list: [],
      dockNav: [{ id: 'example' }, { id: 'module-example' }],
      enabled: () => true

    }),

    shelf: vue.reactive({ rows: [] }),

    shell: vue.reactive({ capabilities: windows ? ['windows'] : [] }),

    hotkeys: {
      comboOf: () => '',
      toolByCombo: { 'Ctrl+Shift+Digit3': 'terminal' },
      recording: null

    },

    mode,

  };

  globalThis.__toolWindowHarness = state;
  browser.happyDOM.setWindowSize({ width, height: 900 });
  Object.defineProperty(browser.navigator, 'userAgent', {
    configurable: true,
    value: mode === 'page' ? 'Browser' : desktopUserAgent('Electron', mode),
  });
  setActivePinia(pinia);

  const { useDockStore } = await compileModule(webFile('src/stores/dock.ts'));
  const dock = useDockStore(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chats', component: { render: () => null } },
      ...tools.filter((item) => item.id !== 'module-example').map((item) => ({

        path: item.route,

        component: { render: () => null },

        meta: { tool: item.plugin ? 'ext' : item.id },

      })),
    ],
  });

  router.addRoute({
    path: '/ext/:id',
    component: { render: () => null },
    meta: { tool: 'ext' },
  });

  await router.push('/chats');
  await router.isReady();

  const component = await compileVue(webFile('src/shared/layout/ToolHost.vue'), {
    stubs: {

      '../../stores/plugins.ts':

        'export const usePluginsStore = () => globalThis.__toolWindowHarness.plugins;',

      '../../stores/taskShelf.ts':

        'export const useTaskShelfStore = () => globalThis.__toolWindowHarness.shelf;',

      '../../stores/hotkeys.ts':

        'export const useHotkeysStore = () => globalThis.__toolWindowHarness.hotkeys;',

      '../../stores/shell.ts':

        'export const useShellStore = () => globalThis.__toolWindowHarness.shell;',

      '../tools/registry.ts': `
        export const toolsOf = () => globalThis.__toolWindowHarness.tools;
        export const toolById = (_, id) => toolsOf().find((item) => item.id === id);
        export const toolAvailability = (item) => item ? 'enabled' : null;
      `,

    },
  });
  const wrapper = mount(component, { global: { plugins: [pinia, router] }, attachTo: document.body });
  const settle = async () => {
    await vue.nextTick();
    await flushPromises();
    await vue.nextTick();
  };

  t.after(() => {
    wrapper.unmount();
    disposePinia(pinia);
    delete globalThis.__toolWindowHarness;
  });
  await settle();

  return {
    browser,
    wrapper,
    dock,
    router,
    mounts,
    unmounts,
    imports,
    contexts,
    state,
    pinia,
    settle

  };
}

/**
 * Находит действие по доступной подписи настоящей кнопки дока.
 * Отсутствие новой кнопки остаётся явным RED реализации.
 */
export function detachButton(wrapper) {
  return wrapper.findAll('button').find((button) => /Открепить/.test(
    button.text() + ' ' + button.attributes('aria-label'),
  ));
}
