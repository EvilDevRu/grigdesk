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
export function remainingUsagePercent(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return 'нет данных';
  }

  const remaining = 100 - value;

  return remaining > 0 && remaining < 1 ? '<1%' : `${Math.round(remaining)}%`;
}

/**
 * Баланс показывается в основных единицах исходной валюты без пересчёта.
 * Маленькая ненулевая сумма сохраняет значащие цифры, в том числе при долге.
 */
export function formatUsageBalance(amount: number, currency: string): string {
  const small = amount !== 0 && Math.abs(amount) < 0.01;
  const options: Intl.NumberFormatOptions = small
    ? { maximumSignificantDigits: 3 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };

  return `${new Intl.NumberFormat('ru-RU', options).format(amount)} ${currency}`;
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
): UsageSummary {
  const raw = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
  const bars = Array.isArray(raw?.bars) ? raw.bars : [];
  const resources = (Array.isArray(raw?.resources) ? raw.resources : [])
    .filter((resource): resource is Record<string, unknown> => !!resource && typeof resource === 'object');
  const windows = bars.map((bar, index): UsageSummaryItem => {
    const value = bar && typeof bar === 'object' ? bar as Record<string, unknown> : {};

    return {
      key: String(value.key || `window-${index}`),
      label: String(value.label || `Окно ${index + 1}`),
      value: remainingUsagePercent(value.pct),
      ...(typeof value.resetsAt === 'string' ? { resetsAt: value.resetsAt } : {}),
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
      label: String(resource.label || 'Баланс'),
      value: formatUsageBalance(balance.amount, balance.currency),
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
    stale: raw?.stale === true || delivery.deliveryStale === true,
    measuredAt: typeof raw?.dataCheckedAt === 'number' && Number.isFinite(raw.dataCheckedAt)
      && raw.dataCheckedAt > 0 ? raw.dataCheckedAt : null,
  };

  if (!providerId) {
    result.label = 'Лимиты запуска неизвестны';
  } else if (!knownProvider) {
    result.label = 'Исполнитель недоступен';
  } else if (!raw && (delivery.status === 'error' || delivery.deliveryStale)) {
    result.label = 'Лимиты недоступны';
    result.detail = delivery.error || 'Обновление недоступно';
    result.tone = 'warn';
  } else if (!raw && (!delivery.status || ['idle', 'loading'].includes(delivery.status))) {
    result.label = 'Лимиты: …';
  } else if (!raw) {
    result.label = 'Нет данных о лимитах';
  } else if (raw.state !== 'ok') {
    result.label = ({
      auth_required: 'Нужен вход',
      blocked: 'Лимиты недоступны',
      rate_limited: 'Проверка отложена',
      unavailable: 'Лимиты недоступны',
      unsupported: 'Нет данных о лимитах',
    } as Record<string, string>)[String(raw.state)] || 'Нет данных о лимитах';
    result.tone = raw.state === 'auth_required' || raw.state === 'blocked' ? 'bad' : 'warn';
    result.stale ||= result.windows.length > 0 || result.balances.length > 0;
  } else if (!result.items.length) {
    result.label = resources.length ? 'Нет числовых данных' : 'Нет данных о лимитах';
  }

  if (delivery.error || delivery.deliveryStale) {
    result.detail = [delivery.error || 'Обновление недоступно', result.detail].filter(Boolean).join(' · ');
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
