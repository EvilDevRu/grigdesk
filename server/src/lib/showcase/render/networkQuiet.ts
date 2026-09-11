// Затишье сети страницы: когда экран догрузил данные, а не просто собрался.
//
// Условие готовности сцены выполняется, когда собрался каркас экрана, а данные
// приходят второй волной запросов: на стенде позиций она стартует через полсекунды
// после появления фильтров и заканчивается ещё через секунду. Записанная до её
// конца сцена показывает пустую таблицу со спиннером — при здоровом стенде.
//
// Общего ожидания тишины Playwright здесь нет намеренно: поток событий или длинный
// опрос висят вечно, и «сеть молчит» в его понимании не наступает никогда. Поэтому
// считаются только МОЛОДЫЕ запросы страницы, а само ожидание ограничено сверху:
// стенд, который грузит данные дольше предела, снимается таким, какой он есть, —
// сцена не срывается, а исполнитель отмечает недождавшееся затишье.

type Listener = (request: object) => void;

// Ровно те события страницы Playwright, что нужны для счёта: объявлены отдельно,
// чтобы затишье проверялось на любом излучателе событий, а не только на браузере.
export interface NetworkSource {
  on(event: 'request', listener: Listener): unknown;
  on(event: 'requestfinished', listener: Listener): unknown;
  on(event: 'requestfailed', listener: Listener): unknown;
  off(event: 'request', listener: Listener): unknown;
  off(event: 'requestfinished', listener: Listener): unknown;
  off(event: 'requestfailed', listener: Listener): unknown;
}

export interface QuietOptions {
  // Сколько подряд сеть должна молчать, чтобы затишье считалось наступившим.
  quietMs: number;
  // Предел ожидания: дольше него сцена не ждёт даже на шумном стенде.
  capMs: number;
  // Запрос старше этого возраста в счёт не идёт: это поток событий или long
  // polling, а не загрузка данных экрана.
  longRequestMs?: number;
}

export const DEFAULT_QUIET = Object.freeze({
  quietMs: 1000,
  capMs: 10_000,
  longRequestMs: 5000,
});

const POLL_MS = 50;

export interface NetworkTracker {
  inFlight(): number;
  quiet(options: QuietOptions): Promise<boolean>;
  dispose(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Счёт запросов страницы с момента подключения. Подключать нужно ДО перехода на
 * адрес сцены: запросы, ушедшие раньше слушателя, ждать было бы нечем. Запрос,
 * так и не дождавшийся события конца, стареет и перестаёт мешать затишью сам —
 * утечка счётчика не превращается в вечное ожидание.
 */
export function trackNetwork(source: NetworkSource): NetworkTracker {
  const started = new Map<object, number>();

  const onRequest: Listener = (request) => {
    started.set(request, Date.now());
  };
  const onDone: Listener = (request) => {
    started.delete(request);
  };

  source.on('request', onRequest);
  source.on('requestfinished', onDone);
  source.on('requestfailed', onDone);

  function young(longRequestMs: number): number {
    const now = Date.now();
    let count = 0;

    for (const at of started.values()) {
      if (now - at < longRequestMs) {
        count += 1;
      }
    }

    return count;
  }

  async function quiet(options: QuietOptions): Promise<boolean> {
    const longRequestMs = options.longRequestMs ?? DEFAULT_QUIET.longRequestMs;
    const startedAt = Date.now();
    let quietSince: number | null = null;

    for (;;) {
      const now = Date.now();

      if (young(longRequestMs) > 0) {
        quietSince = null;
      } else {
        quietSince ??= now;
      }

      if (quietSince !== null && now - quietSince >= options.quietMs) {
        return true;
      }

      if (now - startedAt >= options.capMs) {
        return false;
      }

      await sleep(POLL_MS);
    }
  }

  function dispose(): void {
    source.off('request', onRequest);
    source.off('requestfinished', onDone);
    source.off('requestfailed', onDone);
  }

  return {
    inFlight: () => started.size,
    quiet,
    dispose,
  };
}
