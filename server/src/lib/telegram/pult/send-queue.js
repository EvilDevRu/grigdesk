// Очередь исходящих пульта: Telegram ограничивает ~1 msg/s на чат, поэтому все
// отправки (карточки вотчера и ответы на команды) идут через один планировщик с
// паузой между операциями. Ответ человеку имеет приоритет над фоновым обновлением
// дашборда: иначе пачка карточек при моргнувшей сети задерживает уже готовый ответ
// ассистента на минуты.
//
// Контракт одной операции остаётся best effort, at most once: упавшая операция
// логируется вызывающим, авторетрая нет (Bot API не даёт idempotency key, дубль
// хуже пропуска — правило notify задач Входящих).
const PRIORITY = Object.freeze({
  background: 0,
  normal: 1,
  interactive: 2,
});

export class PultSendQueue {
  constructor({ pauseMs = 1_100 } = {}) {
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
  push(operation, { priority = 'normal' } = {}) {
    if (typeof operation !== 'function') {
      throw new TypeError('PultSendQueue.push: operation должна быть функцией.');
    }
    if (!Object.hasOwn(PRIORITY, priority)) {
      throw new TypeError(`PultSendQueue.push: неизвестный priority ${priority}.`);
    }

    const result = new Promise((resolve, reject) => {
      this.pending.push({
        operation,
        priority: PRIORITY[priority],
        sequence: this.sequence,
        resolve,
        reject,
      });
      this.sequence += 1;
    });
    this._start();
    return result;
  }

  _start() {
    if (this.running) return;
    this.running = true;
    void this._drain();
  }

  /**
   * Выбирать самый срочный ожидающий элемент, сохраняя FIFO внутри одного
   * приоритета. Ошибка возвращается только его владельцу и очередь не ломает.
   */
  async _drain() {
    while (this.pending.length) {
      let selected = 0;
      for (let index = 1; index < this.pending.length; index += 1) {
        const candidate = this.pending[index];
        const current = this.pending[selected];
        if (candidate.priority > current.priority
            || (candidate.priority === current.priority
              && candidate.sequence < current.sequence)) {
          selected = index;
        }
      }

      const item = this.pending.splice(selected, 1)[0];
      let value;
      let error;
      let failed = false;
      try {
        value = await item.operation();
      } catch (caught) {
        error = caught;
        failed = true;
      }

      if (this.pauseMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, this.pauseMs);
          timer.unref?.();
        });
      }

      if (failed) item.reject(error);
      else item.resolve(value);
    }
    this.running = false;
  }
}

export default PultSendQueue;
