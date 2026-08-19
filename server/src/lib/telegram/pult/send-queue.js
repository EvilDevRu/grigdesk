// Очередь исходящих пульта: Telegram ограничивает ~1 msg/s на чат, поэтому все
// отправки (карточки вотчера и ответы на команды) идут через одну цепочку с паузой
// между операциями. Контракт доставки — best effort, at most once: упавшая операция
// логируется вызывающим, авторетрая нет (Bot API не даёт idempotency key, дубль
// хуже пропуска — правило notify задач Входящих).
export class PultSendQueue {
  constructor({ pauseMs = 1_100 } = {}) {
    if (!Number.isSafeInteger(pauseMs) || pauseMs < 0) {
      throw new TypeError('PultSendQueue: pauseMs должен быть неотрицательным целым.');
    }
    this.pauseMs = pauseMs;
    this.queue = Promise.resolve();
  }

  /** Выполнить операцию в порядке очереди; пауза — ПОСЛЕ неё, перед следующей. */
  push(operation) {
    const run = async () => {
      try {
        return await operation();
      } finally {
        if (this.pauseMs > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, this.pauseMs);
            timer.unref?.();
          });
        }
      }
    };
    const result = this.queue.then(run, run);
    // Ошибка операции принадлежит вызывающему; очередь живёт дальше.
    this.queue = result.catch(() => {});
    return result;
  }
}

export default PultSendQueue;
