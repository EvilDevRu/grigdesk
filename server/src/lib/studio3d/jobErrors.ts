import { IntentError } from './intents.ts';
import type { ProviderError } from './provider.ts';

export class JobError extends IntentError {
  readonly data: unknown;

  constructor(code: string, data: unknown = null) {
    super(code);
    this.data = data;
  }
}

export class InjectedCrash extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Остановлено в проверяемой durable границе.');
    this.name = 'StudioJobInjectedCrash';
  }
}

/**
 * Общая безопасная ошибка не раскрывает исходный exception или внешние данные.
 * Одинаковая форма используется отправкой, скачиванием и локальными действиями.
 */
export function fallbackError(kind: ProviderError['kind'], message: string): ProviderError {
  return {
    kind,
    code: null,
    message,
    detail: null,
    retryAfterMs: null
  };
}

