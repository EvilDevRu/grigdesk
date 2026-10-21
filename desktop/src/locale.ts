import { locales, translator } from '../../shared/i18n/catalogs.ts';
import { resolveLocale } from '../../shared/i18n/core.ts';
import type { MessageParams } from '../../shared/i18n/core.ts';

/**
 * Контекст создаётся явно из предпочтения установки и языка операционной системы.
 * Чистые функции без контекста сохраняют русский язык прежних прямых вызовов.
 */
export function createDesktopLocale(options: { preference?: string; systemLanguage?: string }) {
  const locale = resolveLocale(options.preference, options.systemLanguage, locales);

  return {
    ...options,
    locale,
    t: (key: string, params?: MessageParams) => translator.t(locale, key, params),
  };
}

let current = createDesktopLocale({ preference: 'ru' });

/**
 * Новый принятый выбор обновляет контекст главного процесса после сохранения.
 * Настройки профилей и жизненный цикл окон этому контексту не принадлежат.
 */
export function setDesktopLocale(preference: string, systemLanguage: string): void {
  current = createDesktopLocale({ preference, systemLanguage });
}

/**
 * Меню и собственные сообщения читают один текущий язык установки.
 * До явной настройки прежние прямые API остаются русскими.
 */
export function desktopLocale(): string {
  return current.locale;
}

/**
 * Собственное сообщение разрешается в момент показа, а внешняя ошибка остаётся данными.
 * Чистый каталог не зависит от Electron и не запускает эффектов импорта.
 */
export function desktopText(key: string, params?: MessageParams): string {
  return current.t(key, params);
}
