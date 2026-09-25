import { compileVue, webFile } from './compile-vue.js';

const SETTINGS_VIEW = webFile('src/views/SettingsView.vue');

function globalName(prefix, suffix) {
  return JSON.stringify(`${prefix}${suffix}`);
}

function storeStub(prefix, name) {
  return `
    export const ${name} = (...args) =>
      globalThis[${globalName(prefix, 'Stores')}].${name}(...args);
  `;
}

/**
 * Все component-тесты настроек используют реальный публичный UI facade и один
 * TS-aware compiler. Подменяются только product boundaries: сеть, stores, SSE,
 * launcher и тяжёлые дочерние поверхности, не являющиеся предметом конкретного теста.
 */
export function compileSettingsView({
  prefix = '__settings',
  accessOverview = false,
  confirm = false,
} = {}) {
  const stores = [
    ['../stores/providers.js', 'useProvidersStore'],
    ['../stores/auth.js', 'useAuthStore'],
    ['../stores/plugins.js', 'usePluginsStore'],
    ['../stores/chat.js', 'useChatStore'],
    ['../stores/pwa.js', 'usePwaStore'],
  ];
  const storeStubs = Object.fromEntries(
    stores.map(([specifier, name]) => [specifier, storeStub(prefix, name)]),
  );
  const confirmCall = confirm
    ? `globalThis[${globalName(prefix, 'Confirm')}](...args)`
    : 'Promise.resolve(true)';
  const overview = accessOverview
    ? `export default globalThis[${globalName(prefix, 'Overview')}];`
    : 'export default { template: \'<div class="access-overview-stub"></div>\' };';

  return compileVue(SETTINGS_VIEW, {
    stubs: {
      '../shared/apiClient.ts': `
        export const api = globalThis[${globalName(prefix, 'Api')}];
      `,
      '../shared/webLogRuntime.ts': `
        export const getWebLogRuntime = () =>
          globalThis[${globalName(prefix, 'WebLogRuntime')}] || null;
      `,
      ...storeStubs,
      '../composables/useUiContextSource.ts': `
        export const useUiContextSource = () => ({
          update() {},
          focus() {},
          blur() {},
          dispose() {},
        });
      `,
      '../shared/tools/launcher.ts': `
        export const useToolLauncher = () => ({ openTerminal() {} });
      `,
      '../shared/ProviderIcon.vue': `
        export default { props: ['id'], template: '<i class="picon"></i>' };
      `,
      './settings/AccessOverview.vue': overview,
      './settings/ToolHotkeys.vue': `
        export default { template: '<div class="tool-hotkeys-stub"></div>' };
      `,
      './settings/WebLogPanel.vue': `
        export default { template: '<div class="web-log-panel-stub"></div>' };
      `,
      // Каталог плагинов — самостоятельный подраздел со своими stores и модалкой;
      // его поведение стережёт settings-plugins-catalog.component.test.js.
      './settings/PluginsCatalog.vue': `
        export default { template: '<div class="plugins-catalog-stub"></div>' };
      `,
      '../stores/cockpit-update.js': `
        export const blockReasonLabel = (value) => String(value || '');
        export const UPDATE_STAGE_LABELS = {};
        export const useCockpitUpdateStore = (...args) =>
          globalThis[${globalName(prefix, 'Stores')}].useCockpitUpdateStore(...args);
      `,
      '../composables/useSse.ts': `
        export const useSse = () => ({ connected: { value: false } });
      `,
      './services/dialogs': `
        export const confirmDialog = (...args) => ${confirmCall};
        export const alertDialog = async () => {};
        export const promptDialog = async () => null;
      `,
    },
  });
}
