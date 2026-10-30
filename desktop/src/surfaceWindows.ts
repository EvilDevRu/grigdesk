import { randomUUID } from 'node:crypto';

import type { SurfaceTarget } from '../../shared/desktop/surfaceContract.ts';
import { surfaceUrl } from '../../shared/desktop/surfaceContract.ts';
import type { ToolWindowAction, ToolWindowControlResult } from '../../shared/desktop/toolWindowContract.ts';

export interface SurfaceWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
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
  closed?(origin: string, target: SurfaceTarget, instance: string): void;
  beforeShow?(window: SurfaceWindow): void;
  schedule?(callback: () => void, milliseconds: number): () => void;
}
interface Entry {
  window: SurfaceWindow;
  target: SurfaceTarget;
  instance?: string;
  origin: string;
}

type OpenResult = boolean | { opened: boolean; instance?: string };

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
  const pending = new Map<string, Promise<OpenResult>>();
  let generation = 0;

  function focusWindow(window: SurfaceWindow): void {
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
  async function openWindow(origin: string, target: SurfaceTarget, key: string): Promise<OpenResult> {
    const epoch = generation;
    const instance = target.kind === 'tool' ? randomUUID() : undefined;
    const url = surfaceUrl(origin, target, instance);
    let entry: Entry | null = null;
    let cancelTimeout = () => {
    };

    try {
      const window = adapters.create(url, target, [...entries.values()]
        .filter((entry) => entry.target.kind === 'task').length);
      const owned: Entry = {
        window,
        target,
        origin,
        instance,
      };

      entry = owned;
      entries.set(key, owned);
      window.on('closed', () => {
        if (entries.get(key) === owned) {
          entries.delete(key);

          if (owned.instance) {
            adapters.closed?.(origin, target, owned.instance);
          }
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
      focusWindow(window);

      return instance ? { opened: true, instance } : true;
    }
    catch {
      if (entry && entries.get(key) === entry) {
        entries.delete(key);
      }
      if (entry && !entry.window.isDestroyed()) {
        entry.window.destroy();
      }

      return instance ? { opened: false } : false;
    }
    finally {
      cancelTimeout();
    }
  }
  /**
   * Второй клик по загружающейся задаче получает тот же результат, а не второе окно.
   * Живое окно задачи только поднимается: его документ и черновик остаются прежними.
   */
  function open(origin: string, target: SurfaceTarget): Promise<OpenResult> {
    if (origin !== adapters.allowedOrigin()) {
      return Promise.resolve(target.kind === 'tool' ? { opened: false } : false);
    }

    const key = origin + ' ' + target.kind + ':' + target.id;
    const waiting = pending.get(key);

    if (waiting) {
      return waiting;
    }

    const entry = entries.get(key);

    if (entry && !entry.window.isDestroyed()) {
      focusWindow(entry.window);

      return Promise.resolve(entry.instance ? { opened: true, instance: entry.instance } : true);
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

  function status(origin: string) {
    return [...entries.values()].filter((entry) => entry.origin === origin
      && origin === adapters.allowedOrigin() && entry.instance && !entry.window.isDestroyed())
      .map((entry) => ({ id: entry.target.id, instance: entry.instance! }));
  }

/**
 * Поднимает только совпавший живой экземпляр без создания нового окна.
 * Чужая машина и устаревшая instance не получают побочных эффектов.
 */
  function focus(origin: string, target: SurfaceTarget, instance: string): boolean {
    const entry = entries.get(origin + ' ' + target.kind + ':' + target.id);

    if (!entry || entry.instance !== instance || origin !== adapters.allowedOrigin()
      || entry.window.isDestroyed()) {
      return false;
    }

    focusWindow(entry.window);

    return true;
  }

/**
 * Закрывает только совпавший экземпляр текущей машины.
 * Запоздалый запрос старого документа не затрагивает его замену.
 */
  function close(origin: string, target: SurfaceTarget, instance: string): boolean {
    const entry = entries.get(origin + ' ' + target.kind + ':' + target.id);

    if (!entry || entry.instance !== instance || origin !== adapters.allowedOrigin()) {
      return false;
    }

    entry.window.destroy();

    return true;
  }

  /**
   * Изменяет только живое окно инструмента с точной instance текущей машины.
   * Чтение состояния не поднимает окно и отражает максимизацию оконным менеджером.
   */
  function control(origin: string, target: SurfaceTarget, instance: string,
    action: ToolWindowAction): ToolWindowControlResult {
    const entry = entries.get(origin + ' ' + target.kind + ':' + target.id);

    if (target.kind !== 'tool' || !entry || entry.instance !== instance
      || origin !== adapters.allowedOrigin() || entry.window.isDestroyed()) {
      return { accepted: false };
    }

    const window = entry.window;

    if (action === 'minimize') {
      window.minimize();
    } else if (action === 'toggle-maximize') {
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
    }

    return { accepted: true, maximized: window.isMaximized() };
  }

  return {
    open,
    closeAll,
    status,
    focus,
    close,
    control,
  };
}
