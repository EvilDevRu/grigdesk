import { intlLocale } from '../../../../shared/i18n/formats.ts';
import { localeTranslator, type LocaleSource } from '../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../shared/i18n/catalogs.ts';
import { localizeUsageBar, localizeUsageResource } from './providerUsage.ts';

export interface UsageDelivery {
  status?: string;
  receivedAt?: number;
  error?: string;
  deliveryStale?: boolean;
}

export interface UsageSummaryItem {
  key: string;
  label: string;
  value: string;
  resetsAt?: string;
  expired?: boolean;
}

export interface UsageSummary {
  items: UsageSummaryItem[];
  windows: UsageSummaryItem[];
  balances: UsageSummaryItem[];
  resources: {
    key: string;
    label: string;
    summary: string;
    note: string;
  }[];
  label: string;
  detail: string;
  tone: 'muted' | 'warn' | 'bad';
  stale: boolean;
  measuredAt: number | null;
}

/**
 * Процент источника означает расход, неизвестность остаётся неизвестностью.
 * Дробный остаток меньше процента не округляется до видимого исчерпания.
 */
export function remainingUsagePercent(value: unknown,
  locale: LocaleSource = 'ru',
): string {
  const t = localeTranslator(locale);

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return t("core.noData");
  }

  const remaining = 100 - value;

  if (remaining > 0 && remaining < 1) {
    return '<1%';
  }
  if (remaining > 99 && remaining < 100) {
    return '>99%';
  }

  return `${Math.round(remaining)}%`;
}

/**
 * Расход и остаток используют одинаковые границы точного нуля и полного окна.
 * Ненулевые дроби у края шкалы остаются видимыми без ложного округления.
 */
export function usedUsagePercent(value: unknown,
  locale: LocaleSource = 'ru',
): string {
  const t = localeTranslator(locale);

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return t("core.noData");
  }
  if (value > 0 && value < 1) {
    return '<1%';
  }
  if (value > 99 && value < 100) {
    return '>99%';
  }

  return `${Math.round(value)}%`;
}

/**
 * Баланс показывается в основных единицах исходной валюты без пересчёта.
 * Маленькая ненулевая сумма сохраняет значащие цифры, в том числе при долге.
 */
export function formatUsageBalance(
  amount: number,
  currency: string,
  locale: LocaleSource = 'ru',
): string {
  const small = amount !== 0 && Math.abs(amount) < 0.01;
  const options: Intl.NumberFormatOptions = small
    ? { maximumSignificantDigits: 3 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };

  return `${new Intl.NumberFormat(intlLocale(locale), options).format(amount)} ${currency}`;
}

/**
 * Проекция едина для любого адаптера: окна и денежные ресурсы не смешиваются.
 * Ошибки доставки и вендора имеют приоритет над сохранёнными красивыми числами.
 */
export function providerUsageSummary(
  providerId: string,
  entry: unknown,
  delivery: UsageDelivery = {},
  knownProvider = true,
  now = Date.now(),
  locale: LocaleSource = 'ru',

): UsageSummary {
  const t = localeTranslator(locale);

  const raw = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
  const bars = Array.isArray(raw?.bars) ? raw.bars : [];
  const resources = (Array.isArray(raw?.resources) ? raw.resources : [])
    .filter((resource): resource is Record<string, unknown> => !!resource && typeof resource === 'object')
    .map((resource) => localizeUsageResource(providerId, resource, locale));
  const windows = bars.map((bar, index): UsageSummaryItem => {
    const value = localizeUsageBar(providerId,
      bar && typeof bar === 'object' ? bar as Record<string, unknown> : {}, locale);

    return {
      key: String(value.key || `window-${index}`),
      label: String(value.label || t("core.window", { value1: index + 1 })),
      value: remainingUsagePercent(value.pct, locale),
      ...(typeof value.resetsAt === 'string' ? {
        resetsAt: value.resetsAt,
        ...(Date.parse(value.resetsAt) <= now ? { expired: true } : {}),
      } : {}),
    };
  });
  const balances = resources.flatMap((resource): UsageSummaryItem[] => {
    const balance = resource.balance as { amount?: unknown; currency?: unknown } | null;

    if (resource.kind !== 'balance' || typeof balance?.amount !== 'number'
      || !Number.isFinite(balance.amount) || typeof balance.currency !== 'string'
      || !/^[A-Z]{3}$/.test(balance.currency)) {
      return [];
    }

    return [{
      key: String(resource.key),
      label: String(resource.label || t("core.balance")),
      value: formatUsageBalance(balance.amount, balance.currency, locale),
    }];
  });
  const result: UsageSummary = {
    items: windows.length ? windows : balances,
    windows,
    balances,
    resources: resources.map((resource) => ({
      key: String(resource.key || ''),
      label: String(resource.label || ''),
      summary: String(resource.summary || ''),
      note: String(resource.note || ''),
    })),
    label: '',
    detail: typeof raw?.message === 'string' ? raw.message : '',
    tone: 'muted',
    stale: raw?.stale === true || delivery.deliveryStale === true || windows.some((item) => item.expired),
    measuredAt: typeof raw?.dataCheckedAt === 'number' && Number.isFinite(raw.dataCheckedAt)
      && raw.dataCheckedAt > 0 ? raw.dataCheckedAt : null,
  };

  if (!providerId) {
    result.label = t("core.launchLimitsUnknown");
  } else if (!knownProvider) {
    result.label = t("core.providerUnavailable");
  } else if (!raw && (delivery.status === 'error' || delivery.deliveryStale)) {
    result.label = t("core.limitsUnavailable");
    result.detail = delivery.error || t("core.updateUnavailable");
    result.tone = 'warn';
  } else if (!raw && (!delivery.status || ['idle', 'loading'].includes(delivery.status))) {
    result.label = t("core.limits");
  } else if (!raw) {
    result.label = t("core.noLimitData");
  } else if (raw.state !== 'ok') {
    result.label = ({
      auth_required: t("core.signInRequired"),
      blocked: t("core.limitsUnavailable"),
      rate_limited: t("core.checkPostponed"),
      unavailable: t("core.limitsUnavailable"),
      unsupported: t("core.noLimitData"),
    } as Record<string, string>)[String(raw.state)] || t("core.noLimitData");
    result.tone = raw.state === 'auth_required' || raw.state === 'blocked' ? 'bad' : 'warn';
    result.stale ||= result.windows.length > 0 || result.balances.length > 0;
  } else if (!result.items.length) {
    result.label = resources.length ? t("core.noNumericData") : t("core.noLimitData");
  }

  if (delivery.error || delivery.deliveryStale) {
    result.detail = [delivery.error || t("core.updateUnavailable"), result.detail]
      .filter(Boolean).join(' · ');
    result.tone = result.tone === 'bad' ? 'bad' : 'warn';
  }
  if (!providerId || !knownProvider) {
    result.items = [];
    result.windows = [];
    result.balances = [];
    result.resources = [];
    result.measuredAt = null;
  }

  return result;
}
