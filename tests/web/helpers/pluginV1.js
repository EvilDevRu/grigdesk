export const webEntryV1 = {
  entry: '/api/ext/ui-module/module/panel.js',
  css: [],
  locales: {},
};

/**
 * Карточка повторяет публичную проекцию v1 без серверных путей и старых полей.
 * Панель и слот объявлены одновременно, а состояние размещения хранится отдельно.
 */
export function cardV1(overrides = {}) {
  return {
    id: 'ui-module',
    name: 'Модуль проверки',
    version: '1.0.0',
    description: 'Описание модуля v1',
    icon: `/api/plugins/ui-module/icon/${'a'.repeat(64)}`,
    enabled: true,
    system: false,
    category: 'dev',
    compatibility: {
      status: 'compatible',
      code: null,
      reason: null
    },
    entrypoints: { web: structuredClone(webEntryV1) },
    contributes: {
      panels: [{
        title: 'Модуль проверки',
        group: 'dock',
        order: 5
      }],
      slots: [{
        slot: 'provider.popover.after-bars',
        kind: 'provider-usage',
        default: true
      }],
      settings: [],
      commands: [],
      themes: [],
    },
    nav: {
      path: '/ext/ui-module',
      label: 'Модуль проверки',
      group: 'dock',
      order: 5
    },
    settings: [],
    values: { greeting: 'Настройка' },
    placements: [{ slot: 'provider.popover.after-bars', enabled: true }],
    install: null,
    needsRestart: false,
    ...overrides,
  };
}
