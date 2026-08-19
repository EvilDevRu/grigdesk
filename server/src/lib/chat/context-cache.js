// Метрики prompt cache одного обращения к модели. Контракт намеренно отделён
// от provider-а: отсутствие чисел означает «не сообщил», а не нулевой кэш.
const TOKEN_KEYS = ['readTokens', 'writeTokens', 'uncachedTokens'];
const STATUSES = new Set(['reported', 'unavailable', 'not-applicable']);

export function contextCacheStatus(status) {
  return {
    scope: 'request',
    status: STATUSES.has(status) ? status : 'unavailable',
  };
}

/** Собирает reported-метрику и fail-closed отбрасывает нецелые/отрицательные числа. */
export function reportedContextCache(fields = {}) {
  const out = contextCacheStatus('reported');
  let reported = 0;
  for (const key of TOKEN_KEYS) {
    if (!Object.hasOwn(fields, key)) continue;
    const value = fields[key];
    if (!Number.isSafeInteger(value) || value < 0) return contextCacheStatus('unavailable');
    out[key] = value;
    reported += 1;
  }
  return reported ? out : contextCacheStatus('unavailable');
}

/** Не выпускает в SSE/API произвольную форму из executor-а. */
export function normalizeContextCache(value) {
  if (!value || value.scope !== 'request' || !STATUSES.has(value.status)) return null;
  if (value.status !== 'reported') return contextCacheStatus(value.status);
  const fields = {};
  for (const key of TOKEN_KEYS) {
    if (Object.hasOwn(value, key)) fields[key] = value[key];
  }
  return reportedContextCache(fields);
}
