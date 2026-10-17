// Снимок контекста одного запроса. Отсутствующее поле отличается от измеренного нуля:
// прогресс вывода может прийти отдельно и не должен стирать последний замер.
export interface ChatContextUsage {
  contextTokens?: number;
  contextWindow?: number;
  contextMetric?: string;
  contextIsEstimate?: boolean;
}

/**
 * Общая граница метрик для SSE, восстановления хода и его результата.
 * null, строки и накопительный расход не превращаются в заполненность контекста.
 */
export function normalizeContextUsage(value: unknown): ChatContextUsage {
  const out: ChatContextUsage = {};

  if (!value || typeof value !== 'object') {
    return out;
  }

  const source = value as Record<string, unknown>;

  for (const key of ['contextTokens', 'contextWindow'] as const) {
    const tokens = source[key];

    if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) {
      out[key] = tokens;
    }
  }

  if (typeof source.contextMetric === 'string' && source.contextMetric) {
    out.contextMetric = source.contextMetric;
  }
  if (typeof source.contextIsEstimate === 'boolean') {
    out.contextIsEstimate = source.contextIsEstimate;
  }

  return out;
}
