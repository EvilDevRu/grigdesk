// Очередь исходящих пульта: Telegram ограничивает ~1 msg/s на чат, поэтому все
// отправки (карточки вотчера и ответы на команды) идут через один планировщик с
// паузой между операциями. Ответ человеку имеет приоритет над фоновым обновлением
// дашборда: иначе пачка карточек при моргнувшей сети задерживает уже готовый ответ
// ассистента на минуты.
//
// Контракт одной операции остаётся best effort, at most once: упавшая операция
// логируется вызывающим, авторетрая нет (Bot API не даёт idempotency key, дубль
// хуже пропуска — правило notify задач Входящих).
// Одна ожидающая отправка. Приоритет уже переведён в число: сравнение внутри
// очереди не должно каждый раз лазить в словарь имён.
interface QueueItem {
  operation: () => Promise<unknown>;
  priority: number;
  sequence: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}

const PRIORITY = Object.freeze({
  background: 0,
  normal: 1,
  interactive: 2,
});

export class PultSendQueue {
  pauseMs: number;

  pending: QueueItem[];

  running: boolean;

  sequence: number;

  constructor({ pauseMs = 1_100 }: { pauseMs?: number } = {}) {
    if (!Number.isSafeInteger(pauseMs) || pauseMs < 0) {
      throw new TypeError('PultSendQueue: pauseMs должен быть неотрицательным целым.');
    }
    this.pauseMs = pauseMs;
    this.pending = [];
    this.running = false;
    this.sequence = 0;
  }

  /**
   * Поставить Bot API операцию в общую очередь. Приоритет меняет только ещё не
   * начатые элементы; текущий HTTP-вызов не прерывается и сохраняет at-most-once.
   */
  push<Result>(operation: () => Promise<Result>, { priority = 'normal', signal }: {
    priority?: string;
    signal?: AbortSignal;
  } = {}): Promise<Result> {
    if (typeof operation !== 'function') {
      throw new TypeError('PultSendQueue.push: operation должна быть функцией.');
    }
    if (!Object.hasOwn(PRIORITY, priority)) {
      throw new TypeError(`PultSendQueue.push: неизвестный priority ${priority}.`);
    }

    const result = new Promise<Result>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);

        return;
      }

      const cancel = () => {
        const index = this.pending.indexOf(item);

        if (index >= 0) {
          this.pending.splice(index, 1);
          item.detach();
          reject(signal?.reason);
        }
      };
      const item: QueueItem = {
        operation: operation as () => Promise<unknown>,
        priority: (PRIORITY as Record<string, number>)[priority] as number,
        sequence: this.sequence,
        resolve: resolve as (value: unknown) => void,
        reject,
        detach: () => signal?.removeEventListener('abort', cancel),
      };

      this.pending.push(item);
      signal?.addEventListener('abort', cancel, { once: true });
      this.sequence += 1;
    });

    this._start();

    return result;
  }

  _start(): void {
    if (this.running) return;
    this.running = true;
    void this._drain();
  }

  /**
   * Выбирать самый срочный ожидающий элемент, сохраняя FIFO внутри одного
   * приоритета. Ошибка возвращается только его владельцу и очередь не ломает.
   */
  async _drain(): Promise<void> {
    while (this.pending.length) {
      let selected = 0;

      for (let index = 1; index < this.pending.length; index += 1) {
        const candidate = this.pending[index] as QueueItem;
        const current = this.pending[selected] as QueueItem;

        if (candidate.priority > current.priority
            || (candidate.priority === current.priority
              && candidate.sequence < current.sequence)) {
          selected = index;
        }
      }

      const item = this.pending.splice(selected, 1)[0] as QueueItem;

      item.detach();

      let value: unknown;
      let error: unknown;
      let failed = false;
      try {
        value = await item.operation();
      } catch (caught) {
        error = caught;
        failed = true;
      }

      if (failed) {
        item.reject(error);
      } else {
        item.resolve(value);
      }

      if (this.pauseMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, this.pauseMs);

          (timer as { unref?: () => void }).unref?.();
        });
      }
    }
    this.running = false;
  }
}

export default PultSendQueue;
