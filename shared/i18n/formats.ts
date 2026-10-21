import { locales, translator, type LocaleSource } from './catalogs.ts';

/**
 * Порт локали позволяет чистому helper читать актуальный язык без зависимости от Vue.
 * Пропущенный аргумент сохраняет русский контракт прежних прямых вызовов.
 */
export function intlLocale(locale: LocaleSource = 'ru'): string {
  const id = typeof locale === 'string' ? locale : locale.value;

  return locales.find((item) => item.id === id)?.intlLocale ?? 'ru-RU';
}

/**
 * Округление задаёт потребитель, разделители и знаки выбирает Intl.
 * Число остаётся числом до построения видимой подписи.
 */
export function formatNumber(
  value: number,
  locale: LocaleSource = 'ru',
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

/**
 * Календарный формат использует часовой пояс устройства либо явный пояс потребителя.
 * Исходный момент не изменяется при переключении языка интерфейса.
 */
export function formatDate(
  value: Date | number,
  locale: LocaleSource = 'ru',
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), options).format(value);
}

/**
 * Intl выбирает слова и окончания относительного времени для выбранного языка.
 * Знак и единицу интервала определяет вызывающий экран.
 */
export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale: LocaleSource = 'ru',
): string {
  return new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' }).format(value, unit);
}

/**
 * Размеры сохраняют пороги 1024 и округление КБ до целого, МБ и ГБ до десятых.
 * Невалидное значение оставляет пустую подпись, не маскируя данные числом.
 */
export function formatBytes(value: number, locale: LocaleSource = 'ru'): string {
  if (!Number.isFinite(value) || value < 0) {
    return '';
  }

  const index = Math.min(3, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  const id = typeof locale === 'string' ? locale : locale.value;
  const unit = translator.t(id, `core.fileUnits.${index}`);
  const size = value / 1024 ** index;
  const rounded = index < 2 ? Math.round(size) : Math.round(size * 10) / 10;

  return `${formatNumber(rounded, locale)} ${unit}`;
}
