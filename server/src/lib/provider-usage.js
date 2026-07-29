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

function base({ state, bars = [], message = '', action = null, checkedAt, dataCheckedAt, stale = false, retryAt = null }) {
  return {
    state,
    bars: Array.isArray(bars) ? bars : [],
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
  if (
    current.state !== 'ok'
    && !current.bars?.length
    && previous?.bars?.length
  ) {
    return {
      ...current,
      bars: previous.bars,
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
