import type { WebApiTiming } from '../../../shared/web-log/webDiagnostics.ts';

let nextRequest = 0;
let epoch = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();

/**
 * Смена политики или удаление sink снимает ожидания незавершённых запросов.
 * Старое поколение не пишет подробности после повторного включения диагностики.
 */
export function resetApiDiagnostics(): void {
  epoch += 1;
  timers.forEach(clearTimeout);
  timers.clear();
}

/**
 * Замер хранит только этапы, числа и признак явного refresh, без тела ответа и query.
 * Один отложенный сигнал делает видимым запрос, который ещё не завершился и не упал.
 */
export function startApiDiagnostic(options: {
  path: string;
  phase?: 'request' | 'headers';
  enabled: () => boolean;
  pending: (timing: WebApiTiming & { ms: number }) => void;
}) {
  if (!options.enabled()) {
    return null;
  }

  const start = performance.now();
  const generation = epoch;
  const timing: WebApiTiming = {
    request: nextRequest = nextRequest % 1_000_000_000 + 1,
    phase: options.phase ?? 'headers',
    refresh: /[?&]refresh=1(?:&|$)/u.test(options.path.split('#', 1)[0] ?? ''),
  };
  let phaseStarted = start;
  let finished = false;
  const timer = timers.size < 128 ? setTimeout(() => {
    timers.delete(timer!);

    if (!finished && generation === epoch && options.enabled()) {
      options.pending({ ...timing, ms: Math.max(0, performance.now() - start) });
    }
  }, 3000) : undefined;

  if (timer) {
    timers.add(timer);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  return {
    /**
     * Заголовки отделяют ожидание начала ответа от чтения тела.
     * Серверное время принимается только из нашей числовой метрики Server-Timing.
     */
    received(response: Response): void {
      const now = performance.now();

      timing.headersMs = Math.max(0, now - start);
      timing.status = response.status;
      timing.phase = 'body';
      phaseStarted = now;

      try {
        const header = response.headers.get('server-timing') ?? '';
        const match = /(?:^|,)\s*grigdesk;dur=(\d+(?:\.\d+)?)(?:\s*[,;]|\s*$)/u.exec(header);
        const value = match ? Number(match[1]) : NaN;

        if (Number.isFinite(value) && value >= 0 && value <= 1_000_000_000) {
          timing.serverMs = value;
        }
      } catch {
        /* отсутствие метрики у старого сервера не меняет ответ */
      }
    },
    /**
     * Тело уже прочитано: далее измеряется только синхронный разбор JSON.
     * В журнал передаётся длина строки, сама строка не сохраняется.
     */
    parsing(chars: number): void {
      const now = performance.now();

      timing.bodyMs = Math.max(0, now - phaseStarted);
      timing.chars = chars;
      timing.phase = 'parse';
      phaseStarted = now;
    },
    parsed(): void {
      timing.parseMs = Math.max(0, performance.now() - phaseStarted);
      timing.phase = 'done';
    },
    /**
     * Завершение и отмена снимают таймер, сохраняя текущий этап ошибки.
     * Повторное включение логов не возрождает подробности прежней попытки.
     */
    finish(success = false): WebApiTiming {
      clearTimeout(timer);
      finished = true;

      if (timer) {
        timers.delete(timer);
      }
      if (generation !== epoch || !options.enabled()) {
        return {};
      }
      if (timing.phase === 'parse') {
        timing.parseMs = Math.max(0, performance.now() - phaseStarted);
      }
      if (success) {
        timing.phase = 'done';
      }

      return { ...timing };
    },
  };
}

export type ApiDiagnostic = ReturnType<typeof startApiDiagnostic>;
