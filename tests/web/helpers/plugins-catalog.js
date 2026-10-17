import { compileVue, webFile } from './compile-vue.js';

const CATALOG = webFile('src/views/settings/PluginsCatalog.vue');
const PLUGINS_STORE = webFile('src/stores/plugins.js');
const INSTALL_FIXTURE = new URL('./pluginInstallUiFixture.js', import.meta.url).pathname;

/**
 * Раздел «Настройки → Плагины» — самостоятельный подраздел, поэтому тесты монтируют
 * его сам, а не всю страницу настроек. Подменяются только stores; раскладку категорий
 * (`pluginCategoryOf`) берём настоящую — иначе проверялась бы фикстура теста.
 */
export function compilePluginsCatalog({ prefix = '__plugins' } = {}) {
  const stores = JSON.stringify(`${prefix}Stores`);

  return compileVue(CATALOG, {
    stubs: {
      '../../stores/pluginInstall.ts': `
        import { reactive } from 'vue';
        import { pluginInstallUiDouble } from ${JSON.stringify(INSTALL_FIXTURE)};
        const fallback = pluginInstallUiDouble(reactive).state;
        export const usePluginInstallStore = () =>
          globalThis[${stores}].usePluginInstallStore?.() ?? fallback;
      `,
      '../../stores/plugins.js': `
        export { pluginCategoryOf } from ${JSON.stringify(PLUGINS_STORE)};
        export const usePluginsStore = (...args) =>
          globalThis[${stores}].usePluginsStore(...args);
      `,
      '../../stores/providers.js': `
        export const useProvidersStore = (...args) =>
          globalThis[${stores}].useProvidersStore(...args);
      `,
    },
  });
}
