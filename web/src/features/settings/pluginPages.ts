import type { FieldAddress } from './contracts.ts';

// Системные плагины живут в тематических страницах модала настроек, а не во вкладке
// «Установленные» магазина. Карта объявлена рядом с каталогом страниц, чтобы адрес
// поля и страница настроек не могли разъехаться между релизами.
export const SYSTEM_PLUGIN_PAGES: Record<string, string> = {
  ssh: 'connections.ssh',
  db: 'connections.db',
  telegram: 'connections.telegram',
  github: 'connections.github',
  analysis: 'automation.analysis',
  shelf: 'automation.shelf',
  inbox: 'automation.inbox',
  video: 'speech.videoTasks',
  'usage-forecast': 'interface.usageForecast',
  code: 'tools.code',
  docker: 'tools.docker',
  studio3d: 'tools.studio3d',
  showcase: 'tools.showcase',
};

const PLUGIN_OF_PAGE: Record<string, string> = Object.fromEntries(
  Object.entries(SYSTEM_PLUGIN_PAGES).map(([plugin, page]) => [page, plugin]),
);

/**
 * Страница определяется только собственным ключом карты и признаком system.
 * Неизвестный ID остаётся доступен по явной entity; строка в магазине ему не обещается.
 */
export function pluginSettingsPageId(id: string, system: boolean): string {
  return system && Object.hasOwn(SYSTEM_PLUGIN_PAGES, id)
    ? SYSTEM_PLUGIN_PAGES[id]!
    : 'plugins.installed';
}

/**
 * Цель перехода к настройкам плагина: системный идёт на свою страницу без entity,
 * пользовательский — в список «Установленные» с явным выбором.
 */
export function pluginSettingsTarget(id: string, system: boolean): {
  pageId: string;
  entityId?: string;
} {
  const pageId = pluginSettingsPageId(id, system);

  return pageId === 'plugins.installed' ? {
    pageId,
    entityId: id,
  } : { pageId };
}

/**
 * id системного плагина, которому принадлежит страница, — одиночный режим формы
 * плагина. null — страница не из карты (обычные страницы и список магазина).
 */
export function systemPluginOfPage(pageId: string): string | null {
  return Object.hasOwn(PLUGIN_OF_PAGE, pageId) ? PLUGIN_OF_PAGE[pageId]! : null;
}

/**
 * Адрес поля плагина живёт на его странице: системные — в тематическом разделе без
 * entity (страница знает владельца), пользовательские — в списке с entity выбора.
 */
export function pluginFieldAddress(id: string, system: boolean, fieldPath: string[]): FieldAddress {
  const pageId = pluginSettingsPageId(id, system);

  return pageId === 'plugins.installed'
    ? {
      pageId,
      entityId: id,
      fieldPath,
    }
    : {
      pageId,
      fieldPath,
    };
}
