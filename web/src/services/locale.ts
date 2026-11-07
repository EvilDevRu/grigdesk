import { readonly, ref } from 'vue';
import { locales, translator } from '../../../shared/i18n/catalogs.ts';
import type { MessageKey } from '../../../shared/i18n/catalogs.ts';
import type { MessageParams, UiText } from '../../../shared/i18n/core.ts';

const locale = ref('ru');

export const uiLocale = readonly(locale);

export { locales };
export { messageRef } from '../../../shared/i18n/core.ts';
export type { UiText, MessageRef } from '../../../shared/i18n/core.ts';

/**
 * Bootstrap и адаптер устройства публикуют только принятый язык интерфейса.
 * Сам UI-сервис не читает storage, shell или продуктовые stores.
 */
export function setUiLocale(value: string): void {
  locale.value = value;
}

/**
 * Компонент читает реактивную локаль при построении собственной подписи.
 * Тип ключа ограничен общим каталогом переведённых областей.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  return translator.t(locale.value, key, params);
}

/**
 * Descriptor переводится при отображении, поэтому открытый UI меняет язык без пересоздания.
 * Обычная строка возвращается побайтно как данные пользователя или сервера.
 */
export function resolveUiText(text: UiText): string {
  return translator.resolveText(text, locale.value);
}

export { snapshotText } from '../../../shared/i18n/core.ts';
