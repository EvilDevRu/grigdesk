import type { SurfaceTiming, SurfacePhase } from '../../../shared/web-log/surfacePerformance.ts';
import type { WebLog } from './webLog.ts';
import { setPerformanceSurface } from './performanceContext.ts';

type Info = Pick<SurfaceTiming, 'kind' | 'target' | 'view' | 'origin'> & { start?: number };
export type SurfaceHandle = {
  id: number;
  mounted(): void;
  update(pending: number): void;
  finish(phase: Exclude<SurfacePhase, 'start' | 'pending'>): void;
};

/**
 * Автомат хранит только размеры/времена и закрываемые имена исходного кода.
 * DOM, параметры маршрутов и реальные ключи UI-поверхностей в него не передаются.
 */
export function createSurfacePerformance(options: {
  log: WebLog;
  now: () => number;
}) {
  const { log, now } = options;
  const active = new Map<number, {
    handle: SurfaceHandle;
    cancel: () => void;
  }>();
  const seen = new Set<string>();
  let sequence = 0;
  let disposed = false;

  /**
   * API получает номер самого нового незавершённого открытия текущего документа.
   * Это контекст вызова; фоновая работа, начатая в этот момент, может совпасть по времени.
   */
  function context(): void {
    setPerformanceSurface([...active.keys()].at(-1));
  }

  /**
   * Сброс не пишет события запрещённого уровня и не сбрасывает монотонный номер.
   * Поздний результат отменённого handle остаётся no-op.
   */
  function clear(): void {
    for (const entry of active.values()) {
      entry.cancel();
    }

    active.clear();
    context();
  }

  const stopLevel = log.subscribeLevel(() => clear());

  /**
   * Один span имеет ограниченный таймер ожидания и один терминальный исход.
   * Повтор цели означает повтор наблюдения, а не доказанное использование кэша.
   */
  function start(info: Info): SurfaceHandle | null {
    if (disposed || log.level() !== 'verbose' || active.size >= 32) {
      return null;
    }

    const id = sequence += 1;
    const started = info.start ?? now();
    const key = `${info.kind}:${info.target}`;
    const first = !seen.has(key);
    let done = false;
    let pending = 0;
    let mountedMs: number | undefined;

    seen.add(key);

    if (seen.size > 128) {
      seen.delete(seen.values().next().value!);
    }

    /**
     * Каждая запись проходит общую схему и общую политику ядра журнала.
     * Не удерживаем сам Info: в нём может быть служебный ключ вызывающего кода.
     */
    function emit(phase: SurfacePhase): void {
      try {
        log.record('perf.surface', {
          surface: id,
          kind: info.kind,
          target: info.target,
          view: info.view,
          origin: info.origin,
          phase,
          first,
          ms: Math.max(0, now() - started),
          ...(mountedMs === undefined ? {} : { mountedMs }),
          pending,
        });
      } catch {
        /* диагностика не меняет навигацию и состояние UI */
      }
    }

    const timer = setTimeout(() => {
      if (!done && log.level() === 'verbose') {
        emit('pending');
      }
    }, 3000);

    (timer as unknown as { unref?: () => void }).unref?.();

    const handle: SurfaceHandle = {
      id,
      mounted(): void {
        mountedMs ??= Math.max(0, now() - started);
      },
      update(value): void {
        pending = value;
      },
      /**
       * Завершает открытие единственным терминальным исходом.
       * Таймер снимается, а поздний повторный callback ничего не меняет.
       */
      finish(phase): void {
        if (done) {
          return;
        }

        done = true;
        clearTimeout(timer);

        if (log.level() === 'verbose') {
          emit(phase);
        }

        active.delete(id);
        context();
      },
    };

    active.set(id, {
      handle,
      cancel(): void {
        done = true;
        clearTimeout(timer);
      },
    });
    context();
    emit('start');

    return handle;
  }

  return {
    start,
    clear,
    suspend(): void {
      for (const entry of [...active.values()]) {
        entry.handle.finish('suspended');
      }
    },
    dispose(): void {
      disposed = true;
      stopLevel();
      clear();
    },
  };
}
