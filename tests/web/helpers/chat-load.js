import { setImmediate } from 'node:timers/promises';

export const SNAPSHOT_KEY = 'grigdesk-chat-snapshot';
export const LEGACY_KEY = 'grigdesk-chat-v2';

export const SERVER_CHAT = {
  id: 'server-chat',
  title: 'Серверный разговор',
  messages: [{ role: 'assistant', text: 'Ответ с сервера' }],
  createdAt: 100,
  updatedAt: 200,
  steps: [],
};

/**
 * Два оборота очереди завершают чтение stream и реактивные продолжения стора.
 * Реальные часы не двигаются, а сетевые запросы остаются полностью управляемыми.
 */
export async function drain() {
  await setImmediate();
  await setImmediate();
}

/**
 * Каждая фикстура получает отдельный browser storage в памяти и журнал обращений.
 * Исходные значения доступны отдельно от getItem, чтобы проверка не меняла журнал.
 */
export function memoryStorage(t, initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = {
    getItem(key) {
      calls.push(['get', key]);

      return values.get(key) ?? null;
    },
    setItem(key, value) {
      calls.push(['set', key]);
      values.set(key, String(value));
    },
    removeItem(key) {
      calls.push(['remove', key]);
      values.delete(key);
    },
  };

  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous);
    } else {
      delete globalThis.localStorage;
    }
  });

  return { values, calls };
}

/**
 * API записывает наблюдаемые обращения и возвращает корректные пустые служебные списки.
 * Только полный GET меняется сценарием; ни один запрос не выходит в настоящий сервер.
 */
export function loadApi(read = async () => ({ sessions: [SERVER_CHAT], archived: [] })) {
  const calls = [];
  const api = {
    /**
     * Служебные чтения имеют корректную пустую оболочку, а полный GET управляется сценарием.
     * Журнал сохраняет options для проверки opt-in только загрузки истории.
     */
    async get(url, options) {
      calls.push(['GET', url, options]);

      if (url === '/api/chat/store') {
        return structuredClone(await read(options));
      }
      if (url === '/api/chat/pending') {
        return { pending: [] };
      }
      if (url === '/api/chat/waiting?include=ssh,db') {
        return { waiting: [] };
      }

      return { active: [] };
    },
    async put(url, body) {
      calls.push(['PUT', url, body]);

      return { ok: true };
    },
    async post(url, body) {
      calls.push(['POST', url, body]);

      return { ok: true };
    },
    async del(url) {
      calls.push(['DELETE', url]);

      return { ok: true };
    },
  };

  return { api, calls };
}

/**
 * Управляемые часы исполняют таймеры по порядку и дают Promise завершиться между ними.
 * Deadline AbortSignal заменён тем же механизмом: нативный timeout mock-часы не видит.
 */
export function loadClock(t) {
  let now = 100_000;
  let nextId = 0;
  const timers = new Map();

  t.mock.method(globalThis, 'setTimeout', (callback, delay = 0, ...args) => {
    const handle = { id: ++nextId, unref() {} };

    timers.set(handle, { at: now + Number(delay), callback: () => callback(...args) });

    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => timers.delete(handle));
  t.mock.method(Date, 'now', () => now);
  t.mock.method(AbortSignal, 'timeout', (delay) => {
    const controller = new AbortController();

    setTimeout(() => controller.abort(new DOMException('Нет данных', 'TimeoutError')), delay);

    return controller.signal;
  });

  return {
    /**
     * Таймеры запускаются на своей отметке времени, включая новые таймеры продолжений.
     * Ограничение итераций отличает ошибку фикстуры от бесконечного цикла продукта.
     */
    async tick(ms) {
      const end = now + ms;
      let iterations = 0;

      await drain();

      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];

        if (!due) {
          break;
        }
        if (++iterations > 1000) {
          throw new Error('Бесконечный цикл таймеров фикстуры');
        }

        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await drain();
      }

      now = end;
      await drain();
    },
    pending: () => timers.size,
  };
}

/**
 * Fetch-двойник связывает отмену запроса с телом, как делает браузерный fetch.
 * Части задаются байтами: можно разрезать многобайтный символ и проверить TextDecoder.
 */
export function streamFetch(t) {
  const requests = [];

  t.mock.method(globalThis, 'fetch', (_url, options) => {
    let control;
    let ended = false;
    const stream = new ReadableStream({
      start(controller) {
        control = controller;
      },
      cancel() {
        ended = true;
      },
    });
    const request = {
      signal: options.signal,
      push(bytes) {
        if (!ended) {
          control.enqueue(bytes);
        }
      },
      end() {
        if (!ended) {
          ended = true;
          control.close();
        }
      },
    };

    options.signal?.addEventListener('abort', () => {
      if (!ended) {
        ended = true;
        control.error(options.signal.reason);
      }
    }, { once: true });
    requests.push(request);

    return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
  });

  return requests;
}
