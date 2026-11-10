type Lane = string;

interface Waiter {
  lane: Lane;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  cancel: () => void;
}

const active = new Set<Lane>();
const waiting: Waiter[] = [];

/**
 * Каждая полоса допускает ровно одно тело ответа, а не только получение заголовков.
 * Освобождение идемпотентно и запускает следующий подходящий запрос в исходном порядке.
 */
function drain(): void {
  for (const entry of [...waiting]) {
    if (active.has(entry.lane)
      || (entry.lane !== 'local' && [...active].filter((lane) => lane !== 'local').length >= 2)) {
      continue;
    }

    waiting.splice(waiting.indexOf(entry), 1);
    entry.signal?.removeEventListener('abort', entry.cancel);
    active.add(entry.lane);

    let released = false;

    entry.resolve(() => {
      if (released) {
        return;
      }

      released = true;
      active.delete(entry.lane);
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
  const local = /^\/api\/tracker\/(?:[^/]+\/)?task-(?:favorites|seen|shelf)$/u.test(path);
  const driver = /^\/api\/tracker\/([^/]+)\//u.exec(path)?.[1];
  const legacy = ['task', 'task-favorites', 'task-seen', 'task-shelf'].includes(driver ?? '');
  const lane: Lane = local ? 'local' : legacy ? 'portal' : `portal:${driver ?? 'default'}`;

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
