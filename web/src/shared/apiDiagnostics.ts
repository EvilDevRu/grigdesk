import { performanceSurface } from './performanceContext.ts';
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

export type ApiDiagnosticContext = {
  surface?: number;
  epoch: number;
};

/**
 * Контекст логического вызова фиксируется до очереди/backoff и любого await.
 * Он не меняет владельца при переходе пользователя на другой экран.
 */
export function captureApiDiagnosticContext(): ApiDiagnosticContext {
  return { surface: performanceSurface(), epoch };
}

/**
 * Читаем только две числовые метрики из ограниченного заголовка.
 * Произвольные параметры Server-Timing и неизвестный request-id не становятся данными лога.
 */
function responseTiming(response: Response): Partial<WebApiTiming> {
  const result: Partial<WebApiTiming> = {};
  const header = (response.headers.get('server-timing') ?? '').slice(0, 4096);

  for (const [name, field] of [['grigdesk', 'serverMs'], ['grigdesk_pipe', 'pipeMs']] as const) {
    const match = new RegExp(`(?:^|,)\\s*${name};dur=(\\d+(?:\\.\\d+)?)(?:\\s*[,;]|\\s*$)`, 'u')
      .exec(header);
    const value = match ? Number(match[1]) : NaN;

    if (Number.isFinite(value) && value >= 0 && value <= 1_000_000_000) {
      result[field] = value;
    }
  }

  const token = response.headers.get('x-grigdesk-request') ?? '';

  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(token)) {
    result.serverRequest = token;
  }

  return result;
}

/**
 * Замер хранит только этапы, числа и признак явного refresh, без тела ответа и query.
 * Один отложенный сигнал делает видимым запрос, который ещё не завершился и не упал.
 */
export function startApiDiagnostic(options: {
  path: string;
  context: ApiDiagnosticContext;
  complete?: (timing: WebApiTiming & {
    ms: number;
    outcome: 'success' | 'error' | 'cancelled';
  }) => void;
  phase?: 'request' | 'headers';
  enabled: () => boolean;
  pending: (timing: WebApiTiming & { ms: number }) => void;
}) {
  if (!options.enabled() || options.context.epoch !== epoch) {
    return null;
  }

  const start = performance.now();
  const generation = epoch;
  const timing: WebApiTiming = {
    request: nextRequest = nextRequest % 1_000_000_000 + 1,
    surface: options.context.surface,
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
      if (timing.phase !== 'headers' && timing.phase !== 'request') {
        return;
      }

      const now = performance.now();

      timing.headersMs = Math.max(0, now - start);
      timing.status = response.status;
      timing.phase = 'body';
      phaseStarted = now;

      try {
        Object.assign(timing, responseTiming(response));
      } catch {
        /* необязательная диагностика старого или некорректного ответа */
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
    bodyDone(): void {
      timing.bodyMs = Math.max(0, performance.now() - phaseStarted);
      timing.phase = 'done';
    },
    parsed(): void {
      timing.parseMs = Math.max(0, performance.now() - phaseStarted);
      timing.phase = 'done';
    },
    /**
     * Итог пишется один раз и только в исходном поколении диагностики.
     * Сбой приёмника не меняет успешный ответ, исходную ошибку или отмену consumer-а.
     */
    finish(success = false, cancelled = false): WebApiTiming {
      if (finished) {
        return {};
      }

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

      try {
        options.complete?.({
          ...timing,
          ms: Math.max(0, performance.now() - start),
          outcome: success ? 'success' : cancelled ? 'cancelled' : 'error',
        });
      } catch {
        /* наблюдение не меняет транспорт */
      }

      return { ...timing };
    },

  };
}

export type ApiDiagnostic = ReturnType<typeof startApiDiagnostic>;
