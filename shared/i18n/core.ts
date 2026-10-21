import defaultLocales from './assets/locales/catalog.json' with { type: 'json' };

export interface LocaleDefinition {
  id: string;
  name: string;
  intlLocale: string;
}

export type MessageParams = Readonly<Record<string, string | number | MessageRef | undefined>>;
export interface MessageRef {
  readonly key: string;
  readonly params: MessageParams;
  readonly fallback?: string;
}
export type UiText = string | MessageRef;
export type Messages = { [key: string]: string | Messages };

const DEFAULT_LOCALES: LocaleDefinition[] = defaultLocales;

/**
 * Явный зарегистрированный выбор имеет приоритет перед системой.
 * Русская система использует русский, остальные устройства получают английский.
 */
export function resolveLocale(
  preference: unknown,
  systemLanguage?: string,
  locales: readonly LocaleDefinition[] = DEFAULT_LOCALES,
): string {
  if (typeof preference === 'string' && locales.some((item) => item.id === preference)) {
    return preference;
  }

  const language = systemLanguage?.toLowerCase().split(/[-_]/)[0];

  return locales.find((item) => item.id === language)?.id ?? 'en';
}

/**
 * Параметры и вложенные descriptors копируются независимо от вызывающего.
 * Весь открытый вопрос меняет язык, включая собственные пояснения в параметрах.
 */
export function messageRef(key: string, params: MessageParams = {}, fallback?: string): MessageRef {
  return Object.freeze({
    key,
    params: Object.freeze(Object.fromEntries(Object.entries(params).map(([name, value]) => [
      name,
      typeof value === 'object' ? messageRef(value.key, value.params, value.fallback) : value,
    ]))),
    fallback,
  });
}

/**
 * Каталоги передаются явно: ядро не читает окружение и не запускает эффекты.
 * Русский каталог служит запасным, а обычная строка всегда остаётся данными.
 */
export function createTranslator(options: {
  locales: readonly LocaleDefinition[];
  messages: Record<string, Messages>;
}) {
  /**
   * Ключ обходит только дерево объявленного каталога, без окружения и хранилища.
   * Неизвестный сегмент возвращает управление общему русскому fallback.
   */
  const lookup = (locale: string, key: string): string | Messages | undefined => {
    let value: string | Messages | undefined = options.messages[locale];

    for (const part of key.split('.')) {
      value = typeof value === 'object' ? value[part] : undefined;
    }

    return value;
  };
  const intlLocale = (locale: string) =>
    options.locales.find((item) => item.id === locale)?.intlLocale ?? 'ru-RU';

  /**
   * Форма числа выбирается средствами Intl, включая дробные значения.
   * Отсутствующий перевод получает русский текст или явную запасную подпись.
   */
  const t = (locale: string, key: string, params: MessageParams = {}, fallback = ''): string => {
    let value = lookup(locale, key) ?? lookup('ru', key) ?? fallback;

    if (typeof value !== 'string') {
      const category = new Intl.PluralRules(intlLocale(locale)).select(Number(params.count));

      value = value[category] ?? value.other ?? fallback;
    }

    if (typeof value !== 'string') {
      return fallback;
    }

    return value.replace(/\{(\w+)\}/g, (_, name: string) => {
      const parameter = params[name];

      if (typeof parameter === 'object') {
        return t(locale, parameter.key, parameter.params, parameter.fallback);
      }

      return typeof parameter === 'number'
        ? new Intl.NumberFormat(intlLocale(locale)).format(parameter) : String(parameter ?? '');
    });
  };

  return {
    t,
    resolveText(text: UiText, locale = 'ru'): string {
      return typeof text === 'string' ? text : t(locale, text.key, text.params, text.fallback);
    },
  };
}

/**
 * Снимок descriptor копирует параметры даже у объекта, созданного вручную.
 * Обычные строки не интерпретируются как ключи и сохраняются побайтно.
 */
export function snapshotText(text: UiText): UiText {
  return typeof text === 'string' ? text : messageRef(text.key, text.params, text.fallback);
}
