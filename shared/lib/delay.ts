/**
 * Ожидает срок или отмену, отклоняя Promise самим signal.reason.
 * Оба исхода снимают обработчик, отмена также освобождает таймер.
 */
export function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(signal?.reason);
    };
    const timer = setTimeout(finish, ms);

    signal?.addEventListener('abort', cancel, { once: true });
  });
}
