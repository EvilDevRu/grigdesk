import type { SurfaceTarget } from '../../shared/desktop/surfaceContract.ts';
import { surfaceUrl } from '../../shared/desktop/surfaceContract.ts';

export interface SurfaceWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  destroy(): void;
  loadURL(url: string): Promise<unknown>;
  on(event: 'closed', callback: () => void): unknown;
}
interface SurfaceAdapters {
  allowedOrigin(): string | null;
  create(url: string, target: SurfaceTarget, index: number): SurfaceWindow;
  beforeShow?(window: SurfaceWindow): void;
  schedule?(callback: () => void, milliseconds: number): () => void;
}
interface Entry {
  window: SurfaceWindow;
  target: SurfaceTarget;
}

const OPEN_TIMEOUT_MS = 10000;

function schedule(callback: () => void, milliseconds: number): () => void {
  const timer = setTimeout(callback, milliseconds);

  return () => clearTimeout(timer);
}
/**
 * Каждая задача получает своё окно; повтор той же задачи только поднимает его.
 * Смена поколения уничтожает и видимые, и ещё загружающиеся экземпляры.
 */
export function createSurfaceWindows(adapters: SurfaceAdapters) {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<boolean>>();
  let generation = 0;

  function focus(window: SurfaceWindow): void {
    if (window.isMinimized()) {
      window.restore();
    }

    window.show();
    window.focus();
  }
  /**
   * Отрицательный ответ выдаётся лишь после удаления окна этой задачи.
   * Поэтому вызывающий может безопасно показать inline fallback.
   */
  async function openWindow(origin: string, target: SurfaceTarget, key: string): Promise<boolean> {
    const epoch = generation;
    const url = surfaceUrl(origin, target);
    let entry: Entry | null = null;
    let cancelTimeout = () => {
    };

    try {
      const window = adapters.create(url, target, entries.size);
      const owned: Entry = {
        window,
        target,
      };

      entry = owned;
      entries.set(key, owned);
      window.on('closed', () => {
        if (entries.get(key) === owned) {
          entries.delete(key);
        }
      });

      const timeout = new Promise<never>((_resolve, reject) => {
        cancelTimeout = (adapters.schedule ?? schedule)(
          () => reject(new Error('Открытие окна превысило срок.')),
          OPEN_TIMEOUT_MS,
        );
      });

      await Promise.race([window.loadURL(url), timeout]);

      if (epoch !== generation || origin !== adapters.allowedOrigin() || window.isDestroyed()) {
        throw new Error('Открытие отменено.');
      }

      adapters.beforeShow?.(window);
      focus(window);

      return true;
    }
    catch {
      if (entry && entries.get(key) === entry) {
        entries.delete(key);
      }
      if (entry && !entry.window.isDestroyed()) {
        entry.window.destroy();
      }

      return false;
    }
    finally {
      cancelTimeout();
    }
  }
  /**
   * Второй клик по загружающейся задаче получает тот же результат, а не второе окно.
   * Живое окно задачи только поднимается: его документ и черновик остаются прежними.
   */
  function open(origin: string, target: SurfaceTarget): Promise<boolean> {
    if (origin !== adapters.allowedOrigin()) {
      return Promise.resolve(false);
    }

    const key = origin + ' ' + target.kind + ':' + target.id;
    const waiting = pending.get(key);

    if (waiting) {
      return waiting;
    }

    const entry = entries.get(key);

    if (entry && !entry.window.isDestroyed()) {
      focus(entry.window);

      return Promise.resolve(true);
    }

    const opening = openWindow(origin, target, key);
    const release = () => {
      if (pending.get(key) === opening) {
        pending.delete(key);
      }
    };

    pending.set(key, opening);
    void opening.then(release, release);

    return opening;
  }
  /**
   * Выход и смена машины освобождают все окна до навигации главного документа.
   * Поздние завершения прежних загрузок видят новое поколение и окно не показывают.
   */
  function closeAll(): void {
    const windows = [...entries.values()].map((entry) => entry.window);

    generation += 1;
    entries.clear();
    pending.clear();

    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
  }

  return { open, closeAll };
}
