import { messages, translator, type LocaleSource } from '../../../../shared/i18n/catalogs.ts';
import { formatDate, intlLocale } from '../../../../shared/i18n/formats.ts';
import type { MessageParams } from '../../../../shared/i18n/core.ts';

interface UsageTextResource {
  key: string;
  summary?: string;
  note?: string;
  kind?: string;
  balance?: { amount: number; currency: string };
}

const RESOURCE_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  'claude:extra-usage': ['disabled', 'uncapped', 'spent', 'extraCapReached', 'noCap', 'refusal'],
  'codex:spend-control': ['spent', 'exhausted', 'limitReached', 'spendingBlocked', 'serviceReason'],
  'codex:chatgpt-credits': ['unlimited', 'balance', 'creditsManaged', 'creditsUnavailable'],
  'codex:rate-limit-resets': ['available', 'resetNote'],
  'kimi:kimi-extra-usage': ['kimiWalletUnavailable'],
  'kimi:kimi-monthly-volume': ['kimiMonthlyVolumeUnavailable'],
  'deepseek:balance': ['toppedUp', 'bonus', 'insufficientBalance'],
  'glm:balance': ['cash', 'bonus', 'credit'],
  'deepseek:forecast': ['forecastPending', 'stalled', 'hoursLeft', 'daysLeft',
    'observed', 'firstSample', 'sampleInterval', 'dailySpend'],
  'glm:forecast': ['forecastPending', 'stalled', 'hoursLeft', 'daysLeft',
    'observed', 'firstSample', 'sampleInterval', 'dailySpend'],
  'glm:plan': ['unnamedPlan', 'planNote'],
  'tripo:credits': ['credits', 'reserved'],
  'deepseek:tariff': ['peakUntil', 'discountUntil', 'tariffSchedule', 'localHours', 'holiday',
    'calendarMissing', 'pricingMismatch', 'pricingUnparsed', 'pricingUnreachable',
    'pricingStale', 'pricingChecked'],
};

const SOURCE = messages.ru.core.usageText;
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Денежная строка меняет только разделители: целая часть проходит через BigInt.
 * Дробные цифры и внешняя единица сохраняются без округления или потери точности.
 */
export function localizeUsageAmount(value: string, locale: LocaleSource): string {
  const match = /^([−-]?)(\d[\d\s]*?)([.,]\d+)?(\s*[^\d.,\s].*)?$/u.exec(value.trim());

  if (!match) {
    return value;
  }

  const formatter = new Intl.NumberFormat(intlLocale(locale));
  const integer = formatter.format(BigInt(match[2]!.replace(/\s/g, '')));
  const minus = match[1] ? formatter.formatToParts(-1).find((part) => part.type === 'minusSign')?.value : '';
  const decimal = formatter.formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
  const digits = new Intl.NumberFormat(intlLocale(locale), { useGrouping: false });
  const fraction = match[3] ? decimal + [...match[3].slice(1)].map((digit) => digits.format(Number(digit)))
    .join('') : '';
  const id = typeof locale === 'string' ? locale : locale.value;
  const unit = match[4]?.trim() === SOURCE.accountCurrency
    ? ` ${translator.t(id, 'core.usageText.accountCurrency')}` : match[4] ?? '';

  return `${minus || ''}${integer}${fraction}${unit}`;
}

/**
 * Сервер уже выбрал местную календарную дату; UI переводит только её представление.
 * Часы не пересчитываются в другой пояс, неизвестная подпись возвращается как данные.
 */
function calendarText(value: string, locale: LocaleSource): string {
  const clock = /^(?:(.+) )?(\d{1,2}):(\d{2})$/.exec(value);

  if (!clock) {
    return value;
  }

  const hour = Number(clock[2]);
  const minute = Number(clock[3]);
  const time = formatDate(new Date(2000, 0, 2, hour, minute), locale,
    { hour: 'numeric', minute: '2-digit' });
  const day = clock[1];
  const id = typeof locale === 'string' ? locale : locale.value;

  if (!day) {
    return time;
  }

  for (const key of ['today2', 'yesterday', 'tomorrow'] as const) {
    if (messages.ru.core[key].replace(' {time}', '') === day) {
      return translator.t(id, `core.${key}`, { time });
    }
  }

  const weekday = WEEKDAY_KEYS.findIndex((key) => translator.t('ru', `core.usageText.${key}`) === day);

  if (weekday >= 0) {
    return `${formatDate(new Date(2000, 0, 2 + weekday), locale, { weekday: 'short' })} ${time}`;
  }

  const date = /^(\d+) (.+)$/.exec(day);
  const month = date ? MONTH_KEYS.findIndex((key) => translator.t('ru', `core.${key}`) === date[2]) : -1;

  return month < 0 ? value : `${formatDate(new Date(2000, month, Number(date![1])), locale,
    { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * Параметры собственного шаблона форматируются по смыслу, внешняя причина остаётся данными.
 * Полный исходный текст ошибки или неизвестный ресурс в этот путь не передаются.
 */
function parameterText(name: string, value: string, locale: LocaleSource): string | number {
  if (name === 'time') {
    return calendarText(value, locale);
  }

  if (name.endsWith('Schedule')) {
    const [first, second] = value.split(' и ');
    const id = typeof locale === 'string' ? locale : locale.value;

    return second ? translator.t(id, 'core.usageText.schedulePair', { first, second }) : value;
  }

  if (name === 'reason') {
    return caption(value, ['requestLimitReached', 'ownerCreditsDepleted', 'memberCreditsDepleted',
      'ownerUsageLimitReached', 'memberUsageLimitReached'], locale);
  }

  if (name === 'amount' && value === SOURCE.availableCredit) {
    const id = typeof locale === 'string' ? locale : locale.value;

    return translator.t(id, 'core.usageText.availableCredit');
  }

  if (name === 'count' || name === 'year' || name === 'discount' || name === 'factor') {
    const numeric = Number(value.replace(/\s/g, '').replace(',', '.'));

    return Number.isFinite(numeric) ? name === 'year'
      ? new Intl.NumberFormat(intlLocale(locale), { useGrouping: false }).format(numeric) : numeric : value;
  }

  return ['amount', 'used', 'limit', 'cap'].includes(name) ? localizeUsageAmount(value, locale) : value;
}

/**
 * Числовой параметр не поглощает следующую часть составной заметки.
 * Допускаются исходная точность, разделители разрядов и обозначение валюты.
 */
function validParameter(name: string, value: string): boolean {
  if (name === 'amount' && value === SOURCE.availableCredit) {
    return true;
  }

  return !['amount', 'used', 'limit', 'count'].includes(name)
    || /^[−-]?\d[\d\s.,eE+-]*(?:[A-Z\p{Sc}]+)?$/u.test(value);
}

/**
 * Шаблоны выбираются по стабильному provider/resource ID, затем сверяются целиком.
 * Именованные параметры извлекаются из русского каталога, без перевода произвольных строк.
 */
function caption(value: string, keys: readonly string[], locale: LocaleSource): string {
  const id = typeof locale === 'string' ? locale : locale.value;

  for (const key of keys) {
    const source = SOURCE[key as keyof typeof SOURCE];
    const variants = typeof source === 'string' ? [source] : Object.values(source);

    for (const variant of variants) {
      const clipped = variant.endsWith('.') && !value.endsWith('.');
      const template = clipped ? variant.slice(0, -1) : variant;
      const names: string[] = [];
      const pattern = template.split(/(\{\w+\})/).map((part) => {
        if (/^\{\w+\}$/.test(part)) {
          names.push(part.slice(1, -1));

          return '(.+?)';
        }

        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      const match = new RegExp(`^${pattern}$`, 'u').exec(value);

      if (match && names.every((name, index) => validParameter(name, match[index + 1]!))) {
        const params: MessageParams = Object.fromEntries(names.map((name, index) =>
          [name, parameterText(name, match[index + 1]!, locale)]));

        const translated = translator.t(id, `core.usageText.${key}`, params);

        return clipped ? translated.replace(/\.$/, '') : translated;
      }
    }
  }

  return value;
}

/**
 * Составная заметка делится только по собственным разделителям предложения и ресурса.
 * Чужая причина после собственного префикса остаётся одним непрозрачным параметром.
 */
function resourceText(value: string, keys: readonly string[], locale: LocaleSource): string {
  const whole = caption(value, keys, locale);

  if (whole !== value) {
    return whole;
  }

  return value.split(' · ').map((part) => {
    const translated = caption(part, keys, locale);

    return translated !== part ? translated : part.split('. ').map((sentence) =>
      caption(sentence, keys, locale)).join('. ');
  }).join(' · ');
}

/**
 * Проекция меняет собственные сводки и заметки известных ресурсов, сохраняя сырой DTO.
 * Балансы форматируются из чисел, а тексты неизвестного источника не разбираются.
 */
export function localizeUsageResourceText(
  providerId: string,
  resource: UsageTextResource,
  locale: LocaleSource,
): { summary?: string; note?: string } {
  const kind = /^balance-[a-z]{3}$/.test(resource.key) ? 'balance' : resource.key;
  const keys = RESOURCE_TEMPLATES[`${providerId}:${kind}`];

  if (!keys) {
    return {};
  }

  const summary = resource.balance && resource.kind === 'balance'
    ? new Intl.NumberFormat(intlLocale(locale), {
      style: 'currency',
      currency: resource.balance.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(resource.balance.amount)
    : resourceText(resource.summary ?? '', keys, locale);

  return { summary, note: resourceText(resource.note ?? '', keys, locale) };
}
