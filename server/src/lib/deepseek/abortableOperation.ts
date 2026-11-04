/**
 * Отмена освобождает ожидание caller, но не отменяет общий metadata promise.
 * Оба исхода работы наблюдаются и после отмены, без unhandled rejection.
 */
export function waitForDshOperation<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return work;
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };

    signal.addEventListener('abort', abort, {
      once: true
    });
    void work.then((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });

    if (signal.aborted) {
      abort();
    }
  });
}
