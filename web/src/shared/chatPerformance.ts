import { WEB_PERFORMANCE_OPERATIONS } from '../../../shared/web-log/webPerformance.ts';
import type {
  WebPerformanceBlock, WebPerformanceCounts, WebPerformanceOperation,
} from '../../../shared/web-log/webPerformance.ts';
import type { WebLogData, WebLogEvent } from '../../../shared/web-log/webLogContracts.ts';
import type { WebLog } from './webLog.ts';

type Counts = () => WebPerformanceCounts;
type Sample = WebLogData['perf.operation'] & { start: number; end: number };
type Emit = <E extends WebLogEvent>(event: E, data: WebLogData[E]) => unknown;

const noop = () => {};
let activeRecorder: ReturnType<typeof createChatPerformanceRecorder> | null = null;

/**
 * Диагностический вход принимает только целые размеры из закрытого контракта.
 * Дополнительные поля и недоверенные строки не удерживаются даже во временном кольце.
 */
function safeCounts(value: WebPerformanceCounts = {}): WebPerformanceCounts {
  const result: WebPerformanceCounts = {};

  for (const key of ['chats', 'messages', 'steps', 'chars'] as const) {
    const count = value[key];

    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) {
      result[key] = Math.min(count, 1_000_000_000);
    }
  }

  return result;
}

/**
 * Кольцо содержит только времена и размеры; максимум 128 завершённых участков.
 * Сводка ограничена восемью операциями и тремя видами блокировки за пять секунд.
 */
export function createChatPerformanceRecorder(options: {
  now: () => number;
  view: () => string;
  emit: Emit;
  afterFlush: (callback: () => void) => void;
}) {
  const operations = new Map<WebPerformanceOperation, Sample>();
  const blocks = new Map<WebPerformanceBlock, WebLogData['perf.block']>();
  const recent: Sample[] = [];
  let generation = 0;
  let renderPending = false;
  let windowStarted = options.now();

  /**
   * Завершение не пишет в Pinia или storage внутри computed: только обновляет числа.
   * Сбой диагностического счётчика никогда не подменяет результат операции приложения.
   */
  function start(operation: WebPerformanceOperation, counts?: Counts): () => void {
    if (!WEB_PERFORMANCE_OPERATIONS.includes(operation)) {
      return noop;
    }

    const epoch = generation;
    const started = options.now();
    const view = options.view();

    return () => {
      if (epoch !== generation) {
        return;
      }

      try {
        const end = options.now();
        const ms = Math.max(0, end - started);
        const sample: Sample = {
          tag: 'AGENT-DBG',
          operation,
          view,
          ms,
          totalMs: ms,
          count: 1,
          start: started,
          end,
          ...safeCounts(counts?.()),
        };
        const previous = operations.get(operation);

        operations.set(operation, previous ? {
          ...(previous.ms > ms ? previous : sample),
          count: previous.count + 1,
          totalMs: previous.totalMs + ms,
        } : sample);
        recent.push(sample);

        if (recent.length > 128) {
          recent.shift();
        }

        if (operation === 'sse.dispatch' && !renderPending) {
          renderPending = true;

          const finish = start('vue.flush');

          options.afterFlush(() => {
            if (epoch === generation) {
              renderPending = false;
              finish();
            }
          });
        }
      } catch {
        /* диагностика не влияет на рабочий путь */
      }
    };
  }

  /**
   * Совпадение времени показывает соседний участок, но не доказывает причину longtask.
   * Для layout берём отдельные числа Long Animation Frame, если браузер их поддерживает.
   */
  function block(kind: WebPerformanceBlock, startMs: number, ms: number,
    extra: Pick<WebLogData['perf.block'],
      'scriptMs' | 'layoutMs' | 'renderMs' | 'source' | 'position'> = {}): void {
    if (ms < 50) {
      return;
    }

    const overlap = recent.filter((sample) => sample.start < startMs + ms && sample.end > startMs);
    const specific = overlap.filter((sample) => !['sse.dispatch', 'vue.flush'].includes(sample.operation));
    const operation = (specific.length ? specific : overlap).sort((a, b) => b.ms - a.ms)[0];
    const sample: WebLogData['perf.block'] = {
      tag: 'AGENT-DBG',
      kind,
      view: options.view(),
      ms,
      totalMs: ms,
      count: 1,
      startMs,
      ...(operation ? { operation: operation.operation, operationMs: operation.ms } : {}),
      ...extra,
    };
    const previous = blocks.get(kind);

    blocks.set(kind, previous ? {
      ...(previous.ms > ms ? previous : sample),
      count: previous.count + 1,
      totalMs: previous.totalMs + ms,
    } : sample);
  }

  /**
   * Копии сводок отделяются до отправки, чтобы сам журнал не попал в следующий замер.
   * Небольшие операции сохраняются тоже: частые короткие вызовы видны по totalMs/count.
   */
  function flush(): void {
    const samples = [...operations.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 8);
    const stalls = [...blocks.values()];
    const periodMs = Math.max(0, options.now() - windowStarted);

    operations.clear();
    blocks.clear();
    windowStarted = options.now();

    for (const { start: _start, end: _end, ...sample } of samples) {
      options.emit('perf.operation', { ...sample, periodMs });
    }
    for (const sample of stalls) {
      options.emit('perf.block', { ...sample, periodMs });
    }
  }

  return {
    start,
    block,
    flush,
    /**
     * Новое поколение отбрасывает незавершённый nextTick и старые числовые сводки.
     * Выключенная диагностика не удерживает данные предыдущего периода.
     */
    clear(): void {
      generation += 1;
      renderPending = false;
      windowStarted = options.now();
      operations.clear();
      blocks.clear();
      recent.length = 0;
    },
  };
}

/**
 * Выключенная диагностика возвращает общий no-op без часов, размеров и аллокаций.
 * Передаваемые размеры вычисляются лениво и не обходят тела сообщений или steps.
 */
export function startChatPerformance(operation: WebPerformanceOperation, counts?: Counts): () => void {
  try {
    return activeRecorder?.start(operation, counts) ?? noop;
  } catch {
    return noop;
  }
}

/**
 * Ручная отметка включает текущую незавершённую сводку в отправляемую предысторию.
 * В выключенном режиме нет ни таймера, ни активного сборщика.
 */
export function flushChatPerformance(): void {
  activeRecorder?.flush();
}

/**
 * Обёртка возвращает прежнее значение и сохраняет исходное исключение приложения.
 * finally завершает только синхронный участок, ожидание сети сюда не входит.
 */
export function measureChatPerformance<T>(operation: WebPerformanceOperation,
  work: () => T, counts?: Counts): T {
  if (!activeRecorder) {
    return work();
  }

  const finish = startChatPerformance(operation, counts);

  try {
    return work();
  } finally {
    finish();
  }
}

interface FrameEntry extends PerformanceEntry {
  renderStart?: number;
  scripts?: Array<{
    duration: number;
    forcedStyleAndLayoutDuration: number;
    sourceURL: string;
    sourceCharPosition?: number;
  }>;
}

/**
 * Один runtime документа владеет observers и двумя редкими таймерами.
 * Политика off, скрытие страницы и dispose сразу отключают новые замеры и очищают хвост.
 */
export function installChatPerformance(options: {
  log: WebLog;
  win: Window;
  doc: Document;
  view: () => string;
  afterFlush: (callback: () => void) => void;
}): () => void {
  const { log, win, doc } = options;

  if (!win.performance?.now) {
    return noop;
  }

  const now = () => win.performance.now();
  const recorder = createChatPerformanceRecorder({
    ...options,
    now,
    emit: (ev, data) => log.record(ev, data),
  });
  const Observer = (win as Window & { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  const supported = Observer?.supportedEntryTypes ?? [];
  const observers: PerformanceObserver[] = [];
  let timers: ReturnType<typeof setInterval>[] = [];
  let expected = 0;
  let enabled = false;
  let observationEpoch = 0;

  /**
   * Observer читает только числовые метрики и ссылку на JS-ресурс, которую очистит контракт.
   * Скрипты кадра ограничены первыми двадцатью: их тексты, DOM и значения не запрашиваются.
   */
  function observe(type: 'longtask' | 'long-animation-frame'): void {
    if (!Observer || !supported.includes(type)) {
      return;
    }

    try {
      const epoch = observationEpoch;
      const observer = new Observer((list) => {
        if (!enabled || epoch !== observationEpoch) {
          return;
        }

        for (const entry of list.getEntries()) {
          if (type === 'longtask') {
            recorder.block('longtask', entry.startTime, entry.duration);
          } else {
            const frame = entry as FrameEntry;
            const scripts = frame.scripts?.slice(0, 20) ?? [];
            const slowest = scripts.reduce<typeof scripts[number] | undefined>(
              (best, script) => !best || script.duration > best.duration ? script : best, undefined);
            const position = slowest?.sourceCharPosition;

            recorder.block('animation-frame', entry.startTime, entry.duration, {
              scriptMs: scripts.reduce((sum, script) => sum + script.duration, 0),
              layoutMs: scripts.reduce((sum, script) => sum + (script.forcedStyleAndLayoutDuration || 0), 0),
              renderMs: frame.renderStart && frame.renderStart >= frame.startTime
                ? Math.max(0, frame.startTime + frame.duration - frame.renderStart) : 0,
              source: slowest?.sourceURL?.slice(0, 2048) ?? null,
              ...(typeof position === 'number' && Number.isSafeInteger(position) && position >= 0
                ? { position } : {}),
            });
          }
        }
      });

      observer.observe({ type, buffered: false });
      observers.push(observer);
    } catch {
      /* неподдерживаемый observer не отключает таймер и замеры операций */
    }
  }

  /**
   * При каждой смене уровня или видимости сбрасываем прошлое поколение наблюдений.
   * Возврат из фоновой вкладки не выдаётся за многоминутный фриз.
   */
  function sync(): void {
    const next = log.level() === 'verbose' && doc.visibilityState !== 'hidden';

    if (next === enabled) {
      return;
    }

    if (!next && log.level() === 'verbose') {
      recorder.flush();
    }

    enabled = next;
    observationEpoch += 1;
    timers.forEach(clearInterval);
    timers = [];
    observers.splice(0).forEach((observer) => observer.disconnect());
    recorder.clear();
    activeRecorder = next ? recorder : activeRecorder === recorder ? null : activeRecorder;

    if (!next) {
      return;
    }

    expected = now() + 1000;

    const epoch = observationEpoch;

    observe('longtask');
    observe('long-animation-frame');
    log.record('perf.ready', {
      tag: 'AGENT-DBG',
      longTasks: supported.includes('longtask'),
      longFrames: supported.includes('long-animation-frame'),
    });
    timers.push(setInterval(() => {
      if (!enabled || epoch !== observationEpoch) {
        return;
      }

      const current = now();

      recorder.block('event-loop', expected, Math.max(0, current - expected));
      expected = current + 1000;
    }, 1000));
    timers.push(setInterval(() => {
      if (enabled && epoch === observationEpoch) {
        recorder.flush();
      }
    }, 5000));
  }

  const stopLevel = log.subscribeLevel(sync);

  doc.addEventListener('visibilitychange', sync);
  sync();

  return () => {
    enabled = false;
    observationEpoch += 1;
    stopLevel();
    doc.removeEventListener('visibilitychange', sync);
    timers.forEach(clearInterval);
    observers.forEach((observer) => observer.disconnect());
    recorder.clear();

    if (activeRecorder === recorder) {
      activeRecorder = null;
    }
  };
}
