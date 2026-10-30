import type { SafeError, WebLogData, WebLogEvent } from '../../../shared/web-log/webLogContracts.ts';
import { sanitizeWebLogError } from '../../../shared/web-log/webLogContracts.ts';

type Sink = <Event extends WebLogEvent>(event: Event, data: WebLogData[Event]) => unknown;

let sink: Sink | null = null;

/**
 * Извлекает признаки исключения для повторной проекции общим контрактом журнала.
 * Недоступный getter не ломает ловушку; текст и стек никогда не пишутся напрямую.
 */
export function summarizeWebError(value: unknown): SafeError {
  try {
    const error = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const name = typeof error.name === 'string' ? error.name : 'Error';
    const message = typeof error.message === 'string' ? error.message : 'unclassified';
    const stack = typeof error.stack === 'string' ? error.stack : undefined;
    const category = /(?:chunk|dynamically imported module|module script)/iu.test(message)
      ? 'chunk-load' : 'unclassified';

    return sanitizeWebLogError({
      name,
      category,
      message,
      ...(stack ? { stack } : {}),
    });
  } catch {
    return {
      name: 'Error',
      category: 'unclassified',
      message: 'unclassified',
    };
  }
}

/**
 * Общий runtime подключает журнал без обратного импорта stores и UI.
 * Dispose снимает ссылку, поэтому прежнее окно не получает события следующего запуска.
 */
export function setWebDiagnosticSink(value: Sink | null): void {
  sink = value;
}

/**
 * Предметная диагностика передаёт только типизированные поля общего контракта.
 * Отказ наблюдателя не изменяет результат загрузки или применения данных.
 */
export function recordWebDiagnostic<Event extends WebLogEvent>(event: Event, data: WebLogData[Event]): void {
  try {
    sink?.(event, data);
  } catch {
    /* журнал не влияет на состояние приложения */
  }
}
