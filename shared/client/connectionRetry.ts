/**
 * Первые три повтора дают сети быстро восстановиться, затем нагрузка уменьшается.
 * Один предел используется локальной оболочкой, проверкой входа и общим потоком событий.
 */
export function connectionRetryDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(5, attempt - 2)));
}
