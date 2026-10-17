export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SettingsWindowGeometry extends WindowRect {
  minWidth: number;
  minHeight: number;
}

export interface SettingsWindowHandle {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  close(): void;
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown;
}

export interface SettingsWindowControllerOptions {
  canOpen: () => Promise<boolean>;
  create: () => SettingsWindowHandle | null;
  load: (window: SettingsWindowHandle) => Promise<void>;
  onClosed: () => void;
  onLoadFailed: () => void;
}

export interface SettingsWindowController {
  open(): Promise<void>;
  focusOpen(): boolean;
  isOpen(): boolean;
}

/**
 * Центрирует окно относительно родителя и удерживает его в рабочей области.
 * На маленьком дисплее минимум уменьшается вместе с доступным размером.
 */
export function settingsWindowGeometry(parent: WindowRect, area: WindowRect): SettingsWindowGeometry {
  const minWidth = Math.min(800, area.width);
  const minHeight = Math.min(600, area.height);
  const width = Math.max(minWidth, Math.min(1120, area.width));
  const height = Math.max(minHeight, Math.min(820, area.height));
  const centeredX = parent.x + (parent.width - width) / 2;
  const centeredY = parent.y + (parent.height - height) / 2;

  return {
    x: Math.round(Math.max(area.x, Math.min(centeredX, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(centeredY, area.y + area.height - height))),
    width,
    height,
    minWidth,
    minHeight,
  };
}

/**
 * Владеет единственным окном и не показывает его до ready-to-show.
 * Замыкания проверяют текущий handle, поэтому старый отказ не затрагивает новое окно.
 */
export function createSettingsWindowController(
  options: SettingsWindowControllerOptions,
): SettingsWindowController {
  let current: SettingsWindowHandle | null = null;
  let ready = false;
  let opening: Promise<void> | null = null;

  function isOpen(): boolean {
    return current !== null && !current.isDestroyed();
  }

  /**
   * Повторный запрос возвращает фокус без перезагрузки документа.
   * Ещё не готовое окно считается открытым, но остаётся скрытым.
   */
  function focusOpen(): boolean {
    if (!current || current.isDestroyed()) {
      return false;
    }

    if (ready) {
      if (current.isMinimized()) {
        current.restore();
      }

      current.show();
      current.focus();
    }

    return true;
  }

  /**
   * Проверка входа предшествует созданию и не выполняет обмен ключом.
   * Ошибка загрузки закрывает только принадлежащее этой попытке окно.
   */
  async function start(): Promise<void> {
    if (!await options.canOpen()) {
      return;
    }

    const window = options.create();

    if (!window) {
      return;
    }

    current = window;
    ready = false;
    window.once('ready-to-show', () => {
      if (current === window && !window.isDestroyed()) {
        ready = true;
        focusOpen();
      }
    });
    window.once('closed', () => {
      if (current === window) {
        current = null;
        opening = null;
        options.onClosed();
      }
    });

    try {
      await options.load(window);
    } catch {
      if (current !== window) {
        return;
      }

      current = null;

      if (!window.isDestroyed()) {
        window.close();
      }

      options.onLoadFailed();
    }
  }

  /**
   * Все запросы до завершения проверки входа разделяют один Promise.
   * Отказы внешних зависимостей поглощаются на публичной границе контроллера.
   */
  function open(): Promise<void> {
    if (focusOpen()) {
      return Promise.resolve();
    }

    if (opening) {
      return opening;
    }

    const attempt = start().catch(() => { }).finally(() => {
      if (opening === attempt) {
        opening = null;
      }
    });

    opening = attempt;

    return attempt;
  }

  return {
    open,
    focusOpen,
    isOpen,
  };
}
