import { connectionRetryDelay } from '../../../shared/client/connectionRetry.ts';

/**
 * Повтор допускается только для временного отказа чтения, а не для ошибки DTO или доступа.
 * Проверка формы ApiError сохраняется и между разными экземплярами тестовых bundle.
 */
export function isTransientTrackerReadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'TypeError' || error.name === 'TimeoutError' || error.name === 'AbortError') {
    return true;
  }

  const status = (error as Error & { status?: unknown }).status;

  return error.name === 'ApiError' && typeof status === 'number'
    && [408, 429, 500, 502, 503, 504].includes(status);
}

/**
 * Подтверждённый отказ доступа сильнее любого последующего сетевого обрыва.
 * Он очищает прочитанные серверные данные, не становясь причиной автоматического повтора.
 */
export function isTrackerReadAccessFailure(error: unknown): boolean {
  const failure = error as { name?: unknown; status?: unknown } | null;

  return failure?.name === 'ApiError' && (failure.status === 401 || failure.status === 403);
}

/**
 * Один канал владеет только своим отложенным повтором, а не общей сессией API.
 * Текущий reload завершает себя сам; cancel отсеивает поздний запуск по версии.
 */
export function createTrackerReadRecovery(reload: () => Promise<unknown>, allowed: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let version = 0;

  const cancel = () => {
    version += 1;
    clearTimeout(timer);
    timer = undefined;
  };
  const reset = () => {
    cancel();
    attempt = 0;
  };
  /**
   * Повтор планируется после завершённого временного отказа или ожидания ревизии.
   * Версия и допуск повторно проверяются перед запуском отложенного чтения.
   */
  const schedule = (error: unknown, required = false) => {
    cancel();

    if (!allowed() || (!required && !isTransientTrackerReadFailure(error))) {
      return;
    }

    const current = version;

    timer = setTimeout(() => {
      timer = undefined;

      if (current === version && allowed()) {
        void reload().catch(() => undefined);
      }
    }, connectionRetryDelay(attempt++));
    (timer as typeof timer & { unref?: () => void }).unref?.();
  };

  return {
    cancel,
    reset,
    schedule,
  };
}
