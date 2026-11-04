type Lane = 'portal' | 'local';

interface Waiter {
  lane: Lane;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  cancel: () => void;
}

const active: Record<Lane, boolean> = { portal: false, local: false };
const waiting: Waiter[] = [];

/**
 * Каждая полоса допускает ровно одно тело ответа, а не только получение заголовков.
 * Освобождение идемпотентно и запускает следующий подходящий запрос в исходном порядке.
 */
function drain(): void {
  for (const entry of [...waiting]) {
    if (active[entry.lane]) {
      continue;
    }

    waiting.splice(waiting.indexOf(entry), 1);
    entry.signal?.removeEventListener('abort', entry.cancel);
    active[entry.lane] = true;

    let released = false;

    entry.resolve(() => {
      if (released) {
        return;
      }

      released = true;
      active[entry.lane] = false;
      drain();
    });
  }
}

/**
 * Ровно три локальных хранилища имеют собственное место рядом с одним чтением портала.
 * Смена query не создаёт новую полосу, неизвестные API Б24 считаются портальными.
 */
export function acquireB24Capacity(route: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }

  const path = route.split(/[?#]/u, 1)[0] ?? '';
  const local = ['/api/tracker/task-favorites', '/api/tracker/task-seen', '/api/tracker/task-shelf'];
  const lane: Lane = local.includes(path) ? 'local' : 'portal';

  return new Promise((resolve, reject) => {
    const entry: Waiter = {
      lane,
      resolve,
      reject,
      signal,
      cancel: () => {
        const index = waiting.indexOf(entry);

        if (index >= 0) {
          waiting.splice(index, 1);
        }

        signal?.removeEventListener('abort', entry.cancel);
        reject(signal?.reason);
        drain();
      },
    };

    waiting.push(entry);
    signal?.addEventListener('abort', entry.cancel, { once: true });
    drain();
  });
}
