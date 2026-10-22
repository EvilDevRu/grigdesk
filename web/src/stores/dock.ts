import { defineStore } from 'pinia';

interface DockIntent extends Record<string, unknown> {
  id: number;
}

interface DockState {
  isOpen: boolean;
  isExpanded: boolean;
  expandedPreferences: Record<string, boolean>;
  activeTool: string | null;
  width: number;
  preferredWidth: number;
  mounted: Record<string, boolean>;
  intents: Record<string, DockIntent[]>;
  nextIntentId: number;
  runtime: Record<string, Record<string, unknown>>;
}

// Состояние правого дока. Здесь нет списка инструментов: состав и доступность
// задаёт клиентский registry, а store хранит только универсальные runtime-флаги
// и exact-once очереди команд.

export const DOCK_TOOL_KEY = 'grigdesk-dock-tool';
export const DOCK_WIDTH_KEY = 'grigdesk-dock-width';
export const DOCK_EXPANDED_KEY = 'grigdesk-dock-expanded-tools';
const LEGACY_DOCK_EXPANDED_KEY = 'grigdesk-dock-expanded';
export const DEFAULT_DOCK_WIDTH = 560;
export const MIN_DOCK_WIDTH = 380;

/**
 * Читает локальную настройку с прежним запасным значением.
 * Недоступное хранилище не мешает работе дока в текущем окне.
 */
function stored<T extends string | null = string>(key: string, fallback: T = '' as T): string | T {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Читает device-local предпочтения каждого инструмента. Старый общий флаг можно
 * честно отнести только к последнему инструменту: распространять его на все панели
 * означало бы сохранить исходный дефект после миграции.
 */
function storedExpandedPreferences(activeTool: string | null): Record<string, boolean> {
  const raw = stored(DOCK_EXPANDED_KEY, null);

  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }

      return Object.fromEntries(Object.entries(parsed)
        .filter(([id, value]) => id.length <= 100 && value === true)
        .slice(0, 100)) as Record<string, boolean>;
    } catch {
      return {};
    }
  }

  const migrated = activeTool && stored(LEGACY_DOCK_EXPANDED_KEY) === '1'
    ? { [activeTool]: true }
    : {};

  try {
    localStorage.setItem(DOCK_EXPANDED_KEY, JSON.stringify(migrated));
    localStorage.removeItem(LEGACY_DOCK_EXPANDED_KEY);
  } catch {
    // Приватный режим может запретить storage.
  }

  return migrated;
}

/**
 * Запоминает развёрнутость отдельно для каждого инструмента.
 * Ошибка локального storage не отменяет уже применённую геометрию панели.
 */
function persistExpandedPreferences(preferences: Record<string, boolean>): void {
  try {
    localStorage.setItem(DOCK_EXPANDED_KEY, JSON.stringify(preferences));
  } catch {
    // Настройка продолжает действовать до закрытия окна.
  }
}

/**
 * Ограничивает ширину доступным viewport, сохраняя прежнее предпочтение человека.
 * Некорректное числовое значение заменяется стандартной шириной дока.
 */
export function clampDockWidth(
  value: unknown,
  max = Number.POSITIVE_INFINITY,
  min = MIN_DOCK_WIDTH,
): number {
  const n = Number(value);
  const safeMax = Number.isFinite(max) ? Math.max(0, max) : Number.POSITIVE_INFINITY;
  const safeMin = Math.min(Math.max(0, min), safeMax);

  return Math.min(safeMax, Math.max(safeMin, Number.isFinite(n) ? n : DEFAULT_DOCK_WIDTH));
}

export const useDockStore = defineStore('dock', {
  state: (): DockState => {
    const activeTool = stored(DOCK_TOOL_KEY) || null;

    return {
      isOpen: false,
      // Развёрнутое состояние — только геометрия того же overlay-дока. Оно не
      // меняет route, не перезаписывает обычную ширину и не создаёт второй panel.
      isExpanded: false,
      expandedPreferences: storedExpandedPreferences(activeTool),
      activeTool,
      width: clampDockWidth(stored(DOCK_WIDTH_KEY, String(DEFAULT_DOCK_WIDTH))),
      preferredWidth: clampDockWidth(stored(DOCK_WIDTH_KEY, String(DEFAULT_DOCK_WIDTH))),
      mounted: {},
      intents: {},
      nextIntentId: 1,
      // Нужен только индикатору рейки; содержимое терминала сюда не попадает.
      runtime: {},
    };
  },
  getters: {
    expandedPreference: (state) => (
      !!state.activeTool && state.expandedPreferences[state.activeTool] === true
    ),
  },
  actions: {
    /**
     * Запоминает последний инструмент, не меняя его открытость и содержимое.
     * Пустой выбор удаляет сохранённый ключ вместо записи фиктивного id.
     */
    rememberTool(id: string | null | undefined): void {
      this.activeTool = id || null;

      try {
        if (this.activeTool) {
          localStorage.setItem(DOCK_TOOL_KEY, this.activeTool);
        } else {
          localStorage.removeItem(DOCK_TOOL_KEY);
        }
      } catch {
    // Приватный режим может запретить storage.
  }
    },
    /**
     * Открывает ту же панель с её собственной сохранённой геометрией.
     * Переключение инструмента не переносит fullscreen от предыдущего.
     */
    open(id: string | null | undefined): void {
      this.rememberTool(id);
      this.isOpen = !!id;
      // Каждый инструмент восстанавливает свою геометрию даже при переключении
      // внутри уже открытого дока: полноэкранный Code не разворачивает Shelf.
      this.isExpanded = this.isOpen && this.expandedPreference;

      if (id) {
        this.mounted[id] = true;
      }
    },
    close() {
      this.isOpen = false;
      this.isExpanded = false;
    },
    toggle(id: string): void {
      if (this.isOpen && this.activeTool === id) {
        this.close();
      } else {
        this.open(id);
      }
    },
    /**
     * Меняет геометрию открытого дока и при необходимости сохраняет выбор инструмента.
     * Временное ограничение раскладки не переписывает предпочтение человека.
     */
    setExpanded(value: unknown, { persist = true }: { persist?: boolean } = {}): void {
      const expanded = !!value;

      this.isExpanded = this.isOpen && expanded;

      if (persist && this.activeTool) {
        const preferences = { ...this.expandedPreferences };

        if (expanded) {
          preferences[this.activeTool] = true;
        } else {
          delete preferences[this.activeTool];
        }

        this.expandedPreferences = preferences;

        persistExpandedPreferences(preferences);
      }
    },
    toggleExpanded(): void {
      this.setExpanded(!this.isExpanded);
    },
    setMounted(id: string, value: unknown): void {
      if (value) {
        this.mounted[id] = true;
      } else {
        delete this.mounted[id];
      }
    },
    /**
     * Явный ресайз становится желаемой шириной и при завершении сохраняется.
     * Временное ограничение viewport выполняет fitWidth без изменения предпочтения.
     */
    setWidth(value: unknown, {
      max,
      min = MIN_DOCK_WIDTH,
      persist = false,
    }: {
      max?: number;
      min?: number;
      persist?: boolean;
    } = {}): number {
      this.width = clampDockWidth(value, max, min);
      this.preferredWidth = this.width;

      if (persist) {
        try {
          localStorage.setItem(DOCK_WIDTH_KEY, String(Math.round(this.width)));
        } catch {
          // Настройка продолжает действовать до закрытия окна.
        }
      }

      return this.width;
    },
    // Временный clamp не меняет выбор человека и не пишет localStorage.
    fitWidth({ max, min = MIN_DOCK_WIDTH }: { max?: number; min?: number } = {}): void {
      this.width = clampDockWidth(this.preferredWidth, max, min);
    },
    /**
     * Доставляет команду инструменту с последовательным id до его монтирования.
     * Очередь сохраняется при закрытии панели до явного consume.
     */
    enqueue(id: string, payload: Record<string, unknown> = {}): DockIntent {
      const intent = { ...payload, id: this.nextIntentId++ };

      if (!this.intents[id]) {
        this.intents[id] = [];
      }

      this.intents[id]!.push(intent);

      return intent;
    },
    /**
     * Удаляет только принятую команду, сохраняя порядок оставшихся.
     * Пустая очередь освобождается, чтобы старые команды не жили после исполнения.
     */
    consume(id: string, intentId: number): void {
      const queue = this.intents[id] || [];
      const index = queue.findIndex((item) => item.id === intentId);

      if (index >= 0) {
        queue.splice(index, 1);
      }
      if (!queue.length) {
        delete this.intents[id];
      }
    },
    clearIntents(id: string): void {
      delete this.intents[id];
    },
    setRuntime(id: string, value: Record<string, unknown> | null | undefined): void {
      if (value == null) {
        delete this.runtime[id];
      } else {
        this.runtime[id] = { ...(this.runtime[id] || {}), ...value };
      }
    },
    resetRuntime(id: string): void {
      this.setMounted(id, false);
      delete this.runtime[id];
    },
    /**
     * Снимает все runtime-состояния при полном unmount оболочки.
     * Команды прошлого сеанса не должны исполниться после следующего входа.
     */
    resetAllRuntime(): void {
      this.isOpen = false;
      this.isExpanded = false;
      this.mounted = {};
      this.runtime = {};
      // Полный unmount оболочки означает logout/reload: команды прошлого сеанса
      // не должны неожиданно исполниться после следующего входа.
      this.intents = {};
    },
  },
});
