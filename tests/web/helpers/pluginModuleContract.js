import { compileModule, webFile } from './compile-vue.js';

export const descriptor = {
  entry: '/api/ext/ui-module/module/panel.js',
  css: ['/api/ext/ui-module/module/panel.css'],
  locales: {
    ru: '/api/ext/ui-module/module/ru.json',
    en: '/api/ext/ui-module/module/en.json',
  },
};

/**
 * Каталог вымышленный и воспроизводит только публичную форму ответа сервера.
 * Адрес страницы и настройки принадлежат той же карточке, которую читает store.
 */
export function pluginCard(overrides = {}) {
  const id = overrides.id ?? 'ui-module';
  const entry = {
    entry: descriptor.entry.replace('/ui-module/', `/${id}/`),
    css: descriptor.css.map((url) => url.replace('/ui-module/', `/${id}/`)),
    locales: Object.fromEntries(Object.entries(descriptor.locales)
      .map(([locale, url]) => [locale, url.replace('/ui-module/', `/${id}/`)])),
  };

  return {
    id: 'ui-module',
    name: 'Модуль проверки',
    version: '1.0.0',
    description: 'Тестовый модуль',
    icon: null,
    compatibility: {
      status: 'compatible',
      code: null,
      reason: null,
    },
    entrypoints: { web: entry },
    contributes: { panels: [{}], slots: [{
      slot: 'provider.popover.after-bars',
      kind: 'provider-usage',
      default: true,
    }] },
    enabled: true,
    system: false,
    nav: {
       path: '/ignored', 
      label: 'Модуль проверки', 
      group: 'dock', 
      order: 5 
    },
    settings: [],
    values: { greeting: 'Настройка' },
    placements: [{ slot: 'provider.popover.after-bars', enabled: true }],
    ...overrides,
  };
}

/**
 * Тяжёлые панели заменены только на границе ленивого импорта.
 * Настоящий реестр сохраняет порядок, props и выбор вида инструмента.
 */
export function registryModule() {
  return compileModule(webFile('src/shared/tools/registry.ts'), {
    stubs: {
      '../asyncView.ts': 'export const asyncView = (loader) => ({ __asyncLoader: loader });',
      ...Object.fromEntries([
        'code/CodePanel', 'shelf/TaskShelfPanel', 'studio3d/Studio3dPanel', 'terminal/TerminalPanel',
        'ssh/SshPanel', 'db/DbPanel', 'docker/DockerPanel', 'ext/PluginModulePanel',
      ].map((name) => [`../../views/${name}.vue`, 'export default {};'])),
    },
  });
}

