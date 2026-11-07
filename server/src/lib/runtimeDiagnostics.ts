import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';

type Histogram = Pick<ReturnType<typeof monitorEventLoopDelay>,
  'max' | 'percentile' | 'reset' | 'enable' | 'disable'>;

type Ports = {
  now: () => number;
  cpu: () => number;
  memory: () => { rss: number; heapUsed: number };
  histogram: () => Histogram;
  observeGc: (callback: (ms: number) => void) => () => void;
};

/**
 * GC передаёт только длительность, без heap snapshots и сведений об объектах.
 * Неподдерживаемый observer не лишает сервер замеров таймера и ресурсов.
 */
function observeGc(callback: (ms: number) => void): () => void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        callback(entry.duration);
      }
    });

    observer.observe({ entryTypes: ['gc'] });

    return () => observer.disconnect();
  } catch {
    return () => {};
  }
}

/**
 * Сборщик принадлежит процессу сервера и не зависит от открытого раздела окна.
 * Каждый enabled-период начинает новые базовые CPU/loop/GC значения.
 */
export function createRuntimeDiagnostics(emit: (data: Record<string, unknown>) => void,
  ports: Ports = {
    now: () => performance.now(),
    cpu: () => {
      const value = process.cpuUsage();

      return value.user + value.system;
    },
    memory: () => process.memoryUsage(),
    histogram: () => monitorEventLoopDelay({ resolution: 20 }),
    observeGc,
  }) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let histogram: Histogram | null = null;
  let removeGc: (() => void) | null = null;
  let gcMs = 0;
  let gcCount = 0;
  let started = 0;
  let previousCpu = 0;
  let closed = false;
  let generation = 0;

  /**
   * Выключение снимает все ресурсы и не оставляет накопленное окно на потом.
   * Повторный вызов безопасен для изменения уровня и onClose.
   */
  function stop(): void {
    generation += 1;
    clearInterval(timer);
    timer = undefined;
    histogram?.disable();
    histogram = null;
    removeGc?.();
    removeGc = null;
    gcMs = 0;
    gcCount = 0;
  }

  /**
   * Снимок описывает фактическую длительность окна, включая задержку его таймера.
   * CPU в процентах одного ядра может превышать 100 при работе нескольких потоков.
   */
  function sample(): void {
    if (!histogram) {
      return;
    }

    const now = ports.now();
    const periodMs = Math.max(1, now - started);
    const cpu = ports.cpu();
    const memory = ports.memory();
    const row = {
      event: 'server.runtime',
      periodMs,
      loopMaxMs: Number.isFinite(histogram.max) ? histogram.max / 1_000_000 : 0,
      loopP95Ms: histogram.percentile(95) / 1_000_000,
      cpuPercent: Math.max(0, (cpu - previousCpu) / (periodMs * 10)),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      gcMs,
      gcCount,
    };

    started = now;
    previousCpu = cpu;
    gcMs = 0;
    gcCount = 0;
    histogram.reset();

    try {
      emit(row);
    } catch {
      /* logger не управляет рабочим циклом сервера */
    }
  }

  /**
   * Изменение настройки идемпотентно и не создаёт второй интервал.
   * Ресурсы создаются только после разрешения подробного уровня.
   */
  function setEnabled(value: boolean): void {
    if (!value || closed) {
      stop();

      return;
    }
    if (timer) {
      return;
    }

    started = ports.now();
    previousCpu = ports.cpu();
    histogram = ports.histogram();
    histogram.enable();

    const epoch = generation;

    removeGc = ports.observeGc((ms) => {
      if (epoch === generation && histogram && Number.isFinite(ms) && ms >= 0) {
        gcMs += ms;
        gcCount += 1;
      }
    });
    timer = setInterval(sample, 5000);
    timer.unref?.();
  }

  return {
    setEnabled,
    close(): void {
      closed = true;
      stop();
    },
  };
}
