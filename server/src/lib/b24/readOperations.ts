import { AsyncLocalStorage } from 'node:async_hooks';

export type B24ReadOperation = 'identity' | 'dashboard' | 'task' | 'taskPage'
  | 'users' | 'groups' | 'probe';

export interface B24ReadOptions {
  signal?: AbortSignal;
}

export interface B24ReadTrace {
  operation: B24ReadOperation;
  phase: 'queued' | 'started' | 'request' | 'headers' | 'settled';
  outcome?: 'success' | 'error' | 'cancelled' | 'timeout';
  ms?: number;
  waitMs?: number;
  attempt?: number;
  status?: number;
}

type Trace = (event: B24ReadTrace) => void;
type Enqueue = <Value>(fn: () => Promise<Value> | Value) => Promise<Value>;

interface ReadContext {
  signal: AbortSignal;
  operation: B24ReadOperation;
  trace: Trace;
}

interface SharedRead {
  controller: AbortController;
  promise: Promise<unknown>;
  users: number;
  done: boolean;
}

const contexts = new AsyncLocalStorage<ReadContext>();

/**
 * Контекст принадлежит только выполняемому чтению, включая вложенную авторизацию.
 * Мутации вне этого контекста сохраняют прежние правила доставки и повторов.
 */
export function currentB24Read(): ReadContext | undefined {
  return contexts.getStore();
}

/**
 * Отмена прекращает ожидание подписчика, но не выдаёт разрешение физической очереди.
 * Обе ветки исходной работы наблюдаются даже после отмены, исключая потерянный rejection.
 */
function waitForSignal<Value>(work: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal?.removeEventListener('abort', aborted);
      reject(signal?.reason);
    };

    work.then((value) => {
      signal?.removeEventListener('abort', aborted);
      resolve(value);
    }, (error) => {
      signal?.removeEventListener('abort', aborted);
      reject(error);
    });

    if (signal?.aborted) {
      aborted();
    } else {
      signal?.addEventListener('abort', aborted, { once: true });
    }
  });
}

export class B24ReadOperations {
  private readonly enqueue: Enqueue;
  private readonly timeoutMs: number;
  private readonly observer?: Trace;
  private readonly pending = new Map<string, SharedRead>();

  constructor(enqueue: Enqueue, options: { timeoutMs?: number; trace?: Trace } = {}) {
    this.enqueue = enqueue;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.observer = options.trace;
  }

  /**
   * Диагностика получает только закрытую проекцию, без ключа объединения и ошибок.
   * Отказ наблюдателя не меняет результат операции или отмену запроса.
   */
  private trace(event: B24ReadTrace): void {
    try {
      this.observer?.(event);
    } catch {
      // Журнал не влияет на выполнение чтения.
    }
  }

  /**
   * Общий срок начинается до очереди; отменённый callback не обращается к клиенту.
   * В enqueue остаётся настоящая работа, поэтому публичный таймаут не допускает гонку с мутацией.
   */
  private create<Value>(key: string, operation: B24ReadOperation,
    fn: (signal: AbortSignal) => Promise<Value>): SharedRead {
    const controller = new AbortController();
    const startedAt = performance.now();
    let waitMs: number | undefined;
    const entry: SharedRead = {
      controller,
      promise: Promise.resolve(undefined),
      users: 0,
      done: false,
    };
    const timer = setTimeout(() => {
      controller.abort(new DOMException('Чтение Б24 не завершилось вовремя.', 'TimeoutError'));
    }, this.timeoutMs);

    this.trace({ operation, phase: 'queued' });

    const work = this.enqueue(async () => {
      controller.signal.throwIfAborted();
      waitMs = performance.now() - startedAt;
      this.trace({
        operation,
        phase: 'started',
        waitMs,
      });

      return contexts.run({
        signal: controller.signal,
        operation,
        trace: (event) => this.trace(event),
      }, async () => {
        const value = await fn(controller.signal);

        controller.signal.throwIfAborted();

        return value;
      });
    });

    entry.promise = waitForSignal(work, controller.signal).then((value) => {
      this.trace({
        operation,
        phase: 'settled',
        outcome: 'success',
        ms: performance.now() - startedAt,
        waitMs,
      });

      return value;
    }, (error) => {
      const outcome = controller.signal.aborted
        ? controller.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled' : 'error';

      this.trace({
        operation,
        phase: 'settled',
        outcome,
        ms: performance.now() - startedAt,
        waitMs,
      });

      throw error;
    }).finally(() => {
      clearTimeout(timer);
      entry.done = true;

      if (this.pending.get(key) === entry) {
        this.pending.delete(key);
      }
    });

    this.pending.set(key, entry);

    return entry;
  }

  /**
   * Подписчики одного ключа разделяют срок, но отменяются независимо.
   * Последний уход отменяет контроллер; новый запрос получает новую работу и новый срок.
   */
  read<Value>(key: string, operation: B24ReadOperation,
    fn: (signal: AbortSignal) => Promise<Value>, signal?: AbortSignal): Promise<Value> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    const pending = this.pending.get(key);
    const entry = pending && !pending.controller.signal.aborted
      ? pending : this.create(key, operation, fn);

    entry.users += 1;

    return waitForSignal(entry.promise as Promise<Value>, signal).finally(() => {
      entry.users -= 1;

      if (!entry.done && entry.users === 0) {
        entry.controller.abort(new DOMException('Чтение Б24 отменено.', 'AbortError'));
      }
    });
  }

  /**
   * Смена credentials отменяет все старые чтения, включая ожидание очереди.
   * Старые finally не удаляют запись нового поколения благодаря сравнению entry.
   */
  invalidate(): void {
    for (const entry of this.pending.values()) {
      entry.controller.abort(new DOMException('Учётная запись Б24 изменилась.', 'AbortError'));
    }

    this.pending.clear();
  }
}
