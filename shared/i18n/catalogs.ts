import locales from './assets/locales/catalog.json' with { type: 'json' };
import ruCore from './assets/locales/ru/core.json' with { type: 'json' };
import ruSettings from './assets/locales/ru/settings.json' with { type: 'json' };
import ruDesktop from './assets/locales/ru/desktop.json' with { type: 'json' };
import ruNative from './assets/locales/ru/native.json' with { type: 'json' };
import enCore from './assets/locales/en/core.json' with { type: 'json' };
import enSettings from './assets/locales/en/settings.json' with { type: 'json' };
import enDesktop from './assets/locales/en/desktop.json' with { type: 'json' };
import enNative from './assets/locales/en/native.json' with { type: 'json' };
import { createTranslator, messageRef, type MessageParams, type UiText } from './core.ts';

export { locales };

export const messages = {
  ru: {
    core: ruCore,
    settings: ruSettings,
    desktop: ruDesktop,
    native: ruNative,
  },
  en: {
    core: enCore,
    settings: enSettings,
    desktop: enDesktop,
    native: enNative,
  },
};

export type MessageKey = `core.${keyof typeof ruCore}` | `settings.${keyof typeof ruSettings}`
  | `desktop.${keyof typeof ruDesktop}` | `native.${keyof typeof ruNative}`;

export const translator = createTranslator({ locales, messages });

export type LocaleSource = string | { readonly value: string };

/**
 * Чистый потребитель принимает язык либо порт его текущего значения.
 * Порт позволяет сессии сохранить состояние и переводить сообщения после переключения UI.
 */
export function localeTranslator(locale: LocaleSource = 'ru') {
  return (key: string, params?: import('./core.ts').MessageParams): string =>
    translator.t(typeof locale === 'string' ? locale : locale.value, key, params);
}

/**
 * Сохраняемое собственное сообщение удерживает ключ при реактивном источнике языка.
 * Прямые вызовы с обычной локалью сохраняют прежний строковый контракт адаптеров.
 */
export function localeMessage(locale: LocaleSource = 'ru') {
  return (key: string, params?: MessageParams): UiText => typeof locale === 'string'
    ? translator.t(locale, key, params) : messageRef(key, params);
}

/**
 * Публичный снимок разрешает собственный descriptor на текущем языке.
 * Серверные строки не интерпретируются как ключи и возвращаются без изменений.
 */
export function resolveLocaleText(text: UiText, locale: LocaleSource = 'ru'): string {
  return translator.resolveText(text, typeof locale === 'string' ? locale : locale.value);
}

/**
 * Чистые помощники сохраняют русский язык при пропущенной локали.
 * Интерфейс передаёт явную локаль при построении собственного представления.
 */
export function translate(key: string, params?: import('./core.ts').MessageParams, locale = 'ru'): string {
  return translator.t(locale, key, params);
}

/**
 * Справочник сохраняет объект и его ключи, но разрешает подписи при чтении.
 * Реактивный порт обновляет уже смонтированных потребителей без эффектов импорта.
 */
export function messageLabels<T extends Record<string, string>>(
  keys: T,
  locale: LocaleSource = 'ru',
): Readonly<Record<keyof T, string>> {
  const t = localeTranslator(locale);
  const descriptors = Object.fromEntries(Object.entries(keys).map(([id, key]) => [id, {
    enumerable: true,
    get: () => t(key),
  }]));

  return Object.freeze(Object.defineProperties({}, descriptors)) as Readonly<Record<keyof T, string>>;
}

/**
 * Список сохраняет порядок и обычные методы массива, разрешая перевод при чтении.
 * Переключение языка не меняет индексы анимации и не требует создавать список заново.
 */
export function messageList(keys: readonly string[], locale: LocaleSource = 'ru'): readonly string[] {
  const t = localeTranslator(locale);
  const labels = keys.map(() => '');

  keys.forEach((key, index) => {
    Object.defineProperty(labels, index, {
      enumerable: true,
      get: () => t(key),
    });
  });

  return Object.freeze(labels);
}
