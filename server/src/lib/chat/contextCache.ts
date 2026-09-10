// Метрики prompt cache одного обращения к модели. Контракт намеренно отделён
// от provider-а: отсутствие чисел означает «не сообщил», а не нулевой кэш.
const TOKEN_KEYS = ['readTokens', 'writeTokens', 'uncachedTokens'] as const;
const STATUSES = new Set(['reported', 'unavailable', 'not-applicable']);

// Метрика prompt cache одного обращения. Отсутствие чисел означает «провайдер не
// сообщил», а не нулевой кэш, поэтому поля токенов необязательны.
export interface ContextCache {
  scope: 'request';
  status: string;
  readTokens?: number;
  writeTokens?: number;
  uncachedTokens?: number;
}

export function contextCacheStatus(status: unknown): ContextCache {
  return {
    scope: 'request',
    status: STATUSES.has(String(status)) ? String(status) : 'unavailable',
  };
}

/** Собирает reported-метрику и fail-closed отбрасывает нецелые/отрицательные числа. */
export function reportedContextCache(
  fields: Record<string, unknown> = {},
): ContextCache {
  const out = contextCacheStatus('reported');
  let reported = 0;
  for (const key of TOKEN_KEYS) {
    if (!Object.hasOwn(fields, key)) continue;
    const value = fields[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return contextCacheStatus('unavailable');
    }
    out[key as 'readTokens' | 'writeTokens' | 'uncachedTokens'] = value;
    reported += 1;
  }
  return reported ? out : contextCacheStatus('unavailable');
}

/** Не выпускает в SSE/API произвольную форму из executor-а. */
export function normalizeContextCache(value: unknown): ContextCache | null {
  const source = value as ContextCache | null;
  if (!source || source.scope !== 'request' || !STATUSES.has(String(source.status))) return null;
  if (source.status !== 'reported') return contextCacheStatus(source.status);
  const fields: Record<string, unknown> = {};
  const record = source as unknown as Record<string, unknown>;
  for (const key of TOKEN_KEYS) {
    if (Object.hasOwn(source, key)) fields[key] = record[key];
  }
  return reportedContextCache(fields);
}
