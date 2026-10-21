import type { LocaleSource } from '../../../shared/i18n/catalogs.ts';

let source: LocaleSource = 'ru';

export const uiLocalePort = {
  get value(): string {
    return typeof source === 'string' ? source : source.value;
  },
};

/**
 * Продуктовые stores читают структурный порт языка без импорта UI-компонентов.
 * Bootstrap подключает readonly ref; прямые Node-потребители до него остаются русскими.
 */
export function connectUiLocalePort(locale: LocaleSource = 'ru'): void {
  source = locale;
}
