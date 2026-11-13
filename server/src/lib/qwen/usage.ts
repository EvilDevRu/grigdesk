import { reportedContextCache, type ContextCache } from '../chat/contextCache.ts';
import { record } from './transport.ts';

/**
 * Метрики хода Qwen из ACP-потока: выход основного агента, последний контекст и кэш.
 * CLI сообщает `usage_update` (used/size) и `_meta.usage` каждого обращения;
 * субагенты помечены `executionLifecycle.subagentId` и метрики основного не меняют.
 */
export function createQwenUsage(
  onProgress: (tokens: number, info: Record<string, unknown>) => void,
) {
  let outputTokens = 0;
  let contextTokens: number | undefined;
  let contextWindow: number | undefined;
  let contextCache: ContextCache | undefined;
  let subagent = false;

  // Отсутствующее, дробное или отрицательное не становится измеренным нулём.
  const tokens = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

  /**
   * Живой прогресс несёт снимок целиком: без окна и статуса новая цифра
   * рисовалась бы по старой шкале. Отсутствующие поля не стирают прежний замер.
   */
  function publish(): void {
    onProgress(outputTokens, {
      tokensIsEstimate: false,
      ...(contextTokens !== undefined ? {
        contextTokens,
        contextMetric: 'qwen-acp-usage-update',
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      } : {}),
      ...(contextCache ? { contextCache } : {}),
    });
  }

  /**
   * Порядок событий обращения: lifecycle started → дельты → ended → `_meta.usage`
   * → `usage_update`. Признак субагента живёт до следующего started, поэтому
   * поздние usage и usage_update субагента не меняют метрики основного агента.
   */
  function observe(update: Record<string, unknown>): void {
    const meta = record(update._meta);
    const lifecycle = record(meta.executionLifecycle);

    if (lifecycle.phase === 'started' || lifecycle.phase === 'ended') {
      subagent = typeof lifecycle.subagentId === 'string' && lifecycle.subagentId !== '';
    }

    const usage = record(meta.usage);

    if (Object.keys(usage).length && !subagent) {
      const output = tokens(usage.outputTokens);
      const input = tokens(usage.inputTokens);
      const cached = tokens(usage.cachedReadTokens);

      if (output !== null) {
        outputTokens += output;
      }

      // Запись кэша CLI не сообщает: отсутствие поля не выдумывается нулём.
      if (input !== null && cached !== null && cached <= input) {
        contextCache = reportedContextCache({
          readTokens: cached,
          uncachedTokens: input - cached,
        });
      }

      publish();
    }

    if (update.sessionUpdate === 'usage_update' && !subagent) {
      const used = tokens(update.used);
      const size = tokens(update.size);

      if (used !== null) {
        contextTokens = used;

        if (size !== null && size > 0) {
          contextWindow = size;
        }

        publish();
      }
    }
  }

  /**
   * Итог хода сохраняет последний замер контекста и кэш для повторного открытия
   * чата; выход текущего хода уже ушёл в живой прогресс и журнал попытки.
   */
  function result(): Record<string, unknown> {
    return {
      ...(contextTokens !== undefined ? {
        contextTokens,
        contextMetric: 'qwen-acp-usage-update',
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      } : {}),
      ...(contextCache ? { contextCache } : {}),
    };
  }

  return { observe, result };
}
