import { delayWithAbort } from '../../../shared/lib/delay.ts';
import { acquireB24Capacity } from './b24ReadCapacity.ts';

interface RouteState {
  tail: Promise<void>;
  failures: number;
  retryAt: number;
}

const routes = new Map<string, RouteState>();
const lastFailureLog = new Map<string, number>();
const FAILURE_LOG_INTERVAL_MS = 60_000;
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Все читатели одного шаблона Б24 разделяют очередь и паузу, включая разные task id.
 * Параметры поиска не создают независимый обход ограничения частоты.
 */
export function trackerReadRoute(path: string): string | null {
  const route = path.split(/[?#]/u, 1)[0] ?? '';

  return route.startsWith('/api/tracker/')
    ? route.replace(/^(\/api\/tracker\/task)\/[^/]+/u, '$1/:id') : null;
}

/**
 * Уход потребителя отпускает его ожидание очереди немедленно.
 * Продолжения общего предшественника снимают обработчик при любом исходе.
 */
function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal?.removeEventListener('abort', cancel);
      reject(signal?.reason);
    };

    signal?.addEventListener('abort', cancel, { once: true });
    void previous.then(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    });
  });
}

/**
 * Бронирует одну попытку маршрута; завершение меняет паузу до допуска следующего читателя.
 * Отменённое ожидание сохраняет порядок очереди и не сбрасывает накопленный отказ.
 */
export async function acquireTrackerRead(route: string, signal?: AbortSignal) {
  let state = routes.get(route);

  if (!state) {
    state = {
      tail: Promise.resolve(),
      failures: 0,
      retryAt: 0,
    };
    routes.set(route, state);
  }

  const own = state;
  const previous = own.tail;
  let release = () => {};
  let releaseCapacity: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });

  own.tail = previous.then(() => done);

  try {
    await waitForTurn(previous, signal);

    const waitMs = own.retryAt - Date.now();

    if (waitMs > 0) {
      await delayWithAbort(waitMs, signal);
    }

    signal?.throwIfAborted();
    releaseCapacity = await acquireB24Capacity(route, signal);
    signal?.throwIfAborted();
  } catch (error) {
    releaseCapacity?.();
    release();

    throw error;
  }

  let finished = false;

  return (outcome: 'success' | 'failure' | 'cancelled') => {
    if (finished) {
      return;
    }

    finished = true;

    if (outcome === 'failure') {
      own.failures += 1;
      own.retryAt = Date.now() + Math.min(
        MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.min(own.failures - 1, 6),
      );
    } else if (outcome === 'success') {
      own.failures = 0;
      own.retryAt = 0;
    }

    releaseCapacity?.();
    release();
  };
}


/**
 * В журнал проходит один отказ шаблона за скользящую минуту независимо от длительности.
 * Подавление записи не влияет на ошибку, которую получает вызывающий код.
 */
export function shouldLogTrackerFailure(route: string): boolean {
  const now = Date.now();
  const previous = lastFailureLog.get(route);

  if (previous !== undefined && now - previous < FAILURE_LOG_INTERVAL_MS) {
    return false;
  }

  lastFailureLog.set(route, now);

  return true;
}
