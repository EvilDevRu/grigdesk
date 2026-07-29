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

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeControl(value) {
  if (!value || typeof value !== 'object' || !CONTROL_KINDS.has(value.kind)) return null;
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
    kind: value.kind,
    label,
    action,
    ...(value.field && { field: String(value.field) }),
    ...(value.value !== undefined && { value: value.value }),
    ...(typeof value.unit === 'string' && value.unit && { unit: value.unit }),
    ...(Number.isFinite(value.minExclusive) && { minExclusive: value.minExclusive }),
    ...(value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
      && { payload: { ...value.payload } }),
    ...(value.confirm && typeof value.confirm === 'object' && { confirm: value.confirm }),
    ...(value.disabled === true && { disabled: true }),
  };
}

export function normalizeUsageResources(resources) {
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((value) => {
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
      tone: RESOURCE_TONES.has(value.tone) ? value.tone : 'muted',
      ...(Number.isFinite(percent) && { percent: Math.max(0, Math.min(100, Math.round(percent))) }),
      controls: Array.isArray(value.controls)
        ? value.controls.map(normalizeControl).filter(Boolean)
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
}) {
  return {
    state,
    bars: Array.isArray(bars) ? bars : [],
    resources: normalizeUsageResources(resources),
    message: typeof message === 'string' ? message : '',
    action: action && typeof action === 'object' ? action : null,
    checkedAt,
    dataCheckedAt: dataCheckedAt ?? checkedAt,
    stale: !!stale,
    ...(retryAt != null && { retryAt }),
  };
}

export function normalizeProviderUsage(value, { providerName = 'Исполнитель', checkedAt = Date.now() } = {}) {
  if (Array.isArray(value)) {
    return base({ state: 'ok', bars: value, checkedAt, dataCheckedAt: checkedAt });
  }
  if (value && typeof value === 'object') {
    const state = STATES.has(value.state) ? value.state : (Array.isArray(value.bars) ? 'ok' : 'unavailable');
    return base({
      ...value,
      state,
      checkedAt: Number.isFinite(value.checkedAt) ? value.checkedAt : checkedAt,
      dataCheckedAt: Number.isFinite(value.dataCheckedAt) ? value.dataCheckedAt : undefined,
    });
  }
  return base({
    state: 'unavailable',
    message: `Не удалось получить данные о лимитах ${providerName}.`,
    checkedAt,
  });
}

export function mergeProviderUsage(previous, current) {
  if (!current) return previous;
  const needsBars = !current.bars?.length && previous?.bars?.length;
  const needsResources = !current.resources?.length && previous?.resources?.length;
  if (
    current.state !== 'ok'
    && (needsBars || needsResources)
  ) {
    return {
      ...current,
      bars: needsBars ? previous.bars : current.bars,
      resources: needsResources ? previous.resources : current.resources,
      stale: true,
      dataCheckedAt: previous.dataCheckedAt ?? previous.checkedAt,
    };
  }
  return current;
}

export function unsupportedProviderUsage(providerName, checkedAt = Date.now()) {
  return base({
    state: 'unsupported',
    message: `${providerName} CLI не отдаёт данные о лимитах подписки.`,
    checkedAt,
  });
}

/**
 * Provider-owned action dispatcher. Core validates only the stable action id and
 * delegates semantics to the executor adapter. Adding Kimi or another provider
 * therefore does not add a vendor branch to the providers module.
 */
export async function executeProviderUsageAction(executor, {
  actionId,
  payload = {},
  requestId = '',
  config,
  deps,
} = {}) {
  const id = String(actionId || '');
  const handler = ACTION_ID.test(id) ? executor?.usageActions?.[id] : null;
  if (typeof handler !== 'function') return { ok: false, error: 'unknown_usage_action' };
  try {
    return await handler({
      payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {},
      requestId: String(requestId || ''),
      config,
      deps,
    });
  } catch (error) {
    return { ok: false, error: error?.message || 'usage_action_failed' };
  }
}
