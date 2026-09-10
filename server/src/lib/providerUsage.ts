// Единый контракт состояния лимитов исполнителя. Пустой массив больше не означает
// одновременно «лимитов нет», «не авторизован» и «сервер не ответил».
const STATES = new Set([
  'ok',
  'unavailable',
  'auth_required',
  'blocked',
  'rate_limited',
  'unsupported',
]);
const RESOURCE_TONES = new Set(['ok', 'muted', 'warn', 'bad']);
const CONTROL_KINDS = new Set(['toggle', 'number', 'button', 'link']);
const ACTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Ручка ресурса: тумблер, число, кнопка или ссылка. Смысл объявляет адаптер.
export interface UsageControl {
  id: string;
  kind: string;
  label: string;
  href?: string;
  action?: string;
  field?: string;
  value?: unknown;
  unit?: string;
  minExclusive?: number;
  payload?: Record<string, unknown>;
  confirm?: Record<string, unknown>;
  disabled?: boolean;
}

// Ведро лимитов аккаунта: подпись, доля и связанные с ним ручки.
export interface UsageResource {
  key: string;
  label: string;
  summary: string;
  note: string;
  tone: string;
  percent?: number;
  controls: UsageControl[];
}

// Состояние лимитов исполнителя целиком.
export interface ProviderUsage {
  state: string;
  bars: unknown[];
  resources: UsageResource[];
  message: string;
  action: Record<string, unknown> | null;
  checkedAt: number;
  dataCheckedAt: number;
  stale: boolean;
  retryAt?: number;
}

export function safeHttpsUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeControl(raw: unknown): UsageControl | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || !CONTROL_KINDS.has(String(value.kind))) return null;
  const id = String(value.id || '');
  const label = String(value.label || '');
  if (!ACTION_ID.test(id) || !label) return null;

  if (value.kind === 'link') {
    const href = safeHttpsUrl(value.href);
    return href ? { id, kind: 'link', label, href } : null;
  }

  const action = String(value.action || '');
  if (!ACTION_ID.test(action)) return null;
  if ((value.kind === 'toggle' || value.kind === 'number') && !ACTION_ID.test(String(value.field || ''))) {
    return null;
  }

  return {
    id,
    kind: String(value.kind),
    label,
    action,
    ...(Boolean(value.field) && { field: String(value.field) }),
    ...(value.value !== undefined && { value: value.value }),
    ...(typeof value.unit === 'string' && value.unit && { unit: value.unit }),
    ...(Number.isFinite(value.minExclusive) && { minExclusive: Number(value.minExclusive) }),
    ...(Boolean(value.payload) && typeof value.payload === 'object'
      && !Array.isArray(value.payload)
      && { payload: { ...value.payload as Record<string, unknown> } }),
    ...(Boolean(value.confirm) && typeof value.confirm === 'object'
      && { confirm: value.confirm as Record<string, unknown> }),
    ...(value.disabled === true && { disabled: true }),
  };
}

export function normalizeUsageResources(resources: unknown): UsageResource[] {
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((raw): UsageResource[] => {
    const value = raw as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') return [];
    const key = String(value.key || '');
    const label = String(value.label || '');
    if (!ACTION_ID.test(key) || !label) return [];
    const percent = typeof value.percent === 'number' ? value.percent : Number.NaN;
    return [{
      key,
      label,
      summary: typeof value.summary === 'string' ? value.summary : '',
      note: typeof value.note === 'string' ? value.note : '',
      tone: RESOURCE_TONES.has(String(value.tone)) ? String(value.tone) : 'muted',
      ...(Number.isFinite(percent) && { percent: Math.max(0, Math.min(100, Math.round(percent))) }),
      controls: Array.isArray(value.controls)
        ? value.controls.map(normalizeControl).filter((c): c is UsageControl => Boolean(c))
        : [],
    }];
  });
}

function base({
  state,
  bars = [],
  resources = [],
  message = '',
  action = null,
  checkedAt,
  dataCheckedAt,
  stale = false,
  retryAt = null,
}: {
  state: string;
  bars?: unknown;
  resources?: unknown;
  message?: unknown;
  action?: unknown;
  checkedAt: number;
  dataCheckedAt?: number;
  stale?: unknown;
  retryAt?: number | null;
}): ProviderUsage {
  return {
    state,
    bars: Array.isArray(bars) ? bars : [],
    resources: normalizeUsageResources(resources),
    message: typeof message === 'string' ? message : '',
    action: action && typeof action === 'object' ? action as Record<string, unknown> : null,
    checkedAt,
    dataCheckedAt: dataCheckedAt ?? checkedAt,
    stale: !!stale,
    ...(retryAt != null && { retryAt }),
  };
}

export function normalizeProviderUsage(
  value: unknown,
  { providerName = 'Исполнитель', checkedAt = Date.now() } = {},
): ProviderUsage {
  if (Array.isArray(value)) {
    return base({ state: 'ok', bars: value, checkedAt, dataCheckedAt: checkedAt });
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const state = STATES.has(String(source.state))
      ? String(source.state)
      : (Array.isArray(source.bars) ? 'ok' : 'unavailable');
    return base({
      ...source,
      state,
      checkedAt: Number.isFinite(source.checkedAt) ? Number(source.checkedAt) : checkedAt,
      dataCheckedAt: Number.isFinite(source.dataCheckedAt)
        ? Number(source.dataCheckedAt)
        : undefined,
    });
  }
  return base({
    state: 'unavailable',
    message: `Не удалось получить данные о лимитах ${providerName}.`,
    checkedAt,
  });
}

export function mergeProviderUsage(
  previous: ProviderUsage | null | undefined,
  current: ProviderUsage | null | undefined,
): ProviderUsage | null | undefined {
  if (!current) return previous;
  const needsBars = !current.bars?.length && previous?.bars?.length;
  const needsResources = !current.resources?.length && previous?.resources?.length;
  if (
    current.state !== 'ok'
    && (needsBars || needsResources)
  ) {
    return {
      ...current,
      bars: needsBars ? previous?.bars ?? [] : current.bars,
      resources: needsResources ? previous?.resources ?? [] : current.resources,
      stale: true,
      dataCheckedAt: previous?.dataCheckedAt ?? previous?.checkedAt ?? current.checkedAt,
    };
  }
  return current;
}

export function unsupportedProviderUsage(
  providerName: string,
  checkedAt = Date.now(),
): ProviderUsage {
  return base({
    state: 'unsupported',
    message: `${providerName} CLI не отдаёт данные о лимитах подписки.`,
    checkedAt,
  });
}

/**
 * Кэш долгого read-only сбора usage. Одновременные вкладки получают один и тот
 * же in-flight результат, а TTL отсчитывается от ЗАВЕРШЕНИЯ загрузки: медленный
 * исполнитель не должен сделать кэш устаревшим ещё до прихода ответа.
 */
export function createUsageReadCache<Value>(
  load: (previous: Value | null) => Promise<Value> | Value,
  { maxAgeMs = 60_000, now = Date.now } = {},
) {
  let cache: { at: number; value: Value } | null = null;
  let inFlight: Promise<Value> | null = null;
  let generation = 0;

  return {
    async read() {
      if (cache && now() - cache.at < maxAgeMs) return cache.value;
      if (inFlight) return inFlight;

      const startedGeneration = generation;
      const pending = Promise.resolve()
        .then(() => load(cache?.value ?? null))
        .then((value) => {
          if (generation === startedGeneration) cache = { at: now(), value };
          return value;
        })
        .finally(() => {
          if (inFlight === pending) inFlight = null;
        });
      inFlight = pending;
      return pending;
    },

    clear() {
      generation += 1;
      cache = null;
      // Уже начатую read-only операцию не убиваем, но после явного сброса новый
      // читатель не должен получить её потенциально устаревший результат.
      inFlight = null;
    },
  };
}

/**
 * Provider-owned action dispatcher. Core validates only the stable action id and
 * delegates semantics to the executor adapter. Adding Kimi or another provider
 * therefore does not add a vendor branch to the providers module.
 */
export async function executeProviderUsageAction(executor: {
  usageActions?: Record<string, ((input: Record<string, unknown>) => Promise<unknown>) | undefined>;
} | null | undefined, {
  actionId,
  payload = {},
  requestId = '',
  config,
  deps,
}: {
  actionId?: unknown;
  payload?: unknown;
  requestId?: unknown;
  config?: unknown;
  deps?: unknown;
} = {}): Promise<unknown> {
  const id = String(actionId || '');
  const handler = ACTION_ID.test(id) ? executor?.usageActions?.[id] : null;
  if (typeof handler !== 'function') return { ok: false, error: 'unknown_usage_action' };
  try {
    return await handler({
      payload: payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {},
      requestId: String(requestId || ''),
      config,
      deps,
    });
  } catch (error) {
    return {
      ok: false,
      error: (error as { message?: unknown } | null)?.message || 'usage_action_failed',
    };
  }
}
