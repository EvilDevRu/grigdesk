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
  return {
    id: 'ui-module',
    name: 'Модуль проверки',
    version: '1.0.0',
    description: '',
    enabled: true,
    system: false,
    nav: {
       path: '/ignored', 
      label: 'Модуль проверки', 
      icon: 'plugin', 
      group: 'dock', 
      order: 5 
    },
    web: null,
    settings: [],
    values: { greeting: 'Настройка' },
    placements: [],
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
        'ssh/SshPanel', 'db/DbPanel', 'docker/DockerPanel', 'ext/PluginFramePanel', 'ext/PluginModulePanel',
      ].map((name) => [`../../views/${name}.vue`, 'export default {};'])),
    },
  });
}

