import { compileVue, webFile } from '../../helpers/compile-vue.js';
import { installUiBrowser } from '../../helpers/ui-components.js';

/**
 * Окно получает настоящий lifecycle, но синтетический receiver вместо межоконной трубы.
 * Панель считает mount/importState; каркас окна остаётся настоящим продуктовым компонентом.
 */
export async function mountLoadingToolWindow(t) {
  await installUiBrowser(t);

  const { defineComponent, h, onMounted } = await import('../../../../web/node_modules/vue/index.mjs');
  const { mount, flushPromises } = await import(
    '../../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const control = {
    mounts: 0,
    imports: [],
    options: null
  };
  const panel = defineComponent({
    setup(_, { expose }) {
      expose({ importState: (state) => control.imports.push(state) });
      onMounted(() => {
        control.mounts += 1;
      });

      return () => h('section', { 'data-window-ready': true }, 'Готовая панель');
    },
  });
  const previousChannel = globalThis.BroadcastChannel;

  globalThis.BroadcastChannel = class {
    close() {}
    postMessage() {}
  };
  globalThis.__loadingToolWindow = {
    control,
    panel
  };
  t.after(() => {
    globalThis.BroadcastChannel = previousChannel;
    delete globalThis.__loadingToolWindow;
  });

  const component = await compileVue(webFile('src/views/ToolWindowPage.vue'), { stubs: {
    '../stores/auth.ts': `export const useAuthStore = () => ({
      authenticated: true, clientScope: 'fixture',
    });`,
    '../stores/plugins.ts': 'export const usePluginsStore = () => ({ load: async () => {} });',
    '../shared/tools/registry.ts': `export const toolById = () => ({
      id: 'shelf', label: 'Полка', component: globalThis.__loadingToolWindow.panel,
    });`,
    '../shared/tools/toolWindowRelay.ts': `export const createToolWindowReceiver = (options) => {
      globalThis.__loadingToolWindow.control.options = options;
      return { ready() {}, context() {}, dispose() {}, mainAction() {}, consume() {}, returnState() {} };
    };`,
  } });
  const wrapper = mount(component, { props: {
    target: {
      kind: 'tool',
      id: 'shelf',
      instance: 'fixture-instance'
    },
    ready: true,
  } });

  t.after(() => wrapper.unmount());
  await flushPromises();

  return {
    wrapper,
    control,
    flushPromises
  };
}
