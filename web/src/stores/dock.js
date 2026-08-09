// Состояние правого дока. Здесь нет списка инструментов: состав и доступность
// задаёт клиентский registry, а store хранит только универсальные runtime-флаги
// и exact-once очереди команд.
import { defineStore } from 'pinia';

export const DOCK_TOOL_KEY = 'cockpit-dock-tool';
export const DOCK_WIDTH_KEY = 'cockpit-dock-width';
export const DOCK_EXPANDED_KEY = 'cockpit-dock-expanded';
export const DEFAULT_DOCK_WIDTH = 560;
export const MIN_DOCK_WIDTH = 380;

function stored(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

export function clampDockWidth(value, max = Number.POSITIVE_INFINITY, min = MIN_DOCK_WIDTH) {
  const n = Number(value);
  const safeMax = Number.isFinite(max) ? Math.max(0, max) : Number.POSITIVE_INFINITY;
  const safeMin = Math.min(Math.max(0, min), safeMax);
  return Math.min(safeMax, Math.max(safeMin, Number.isFinite(n) ? n : DEFAULT_DOCK_WIDTH));
}

export const useDockStore = defineStore('dock', {
  state: () => ({
    isOpen: false,
    // Развёрнутое состояние — только геометрия того же overlay-дока. Оно не
    // меняет route, не перезаписывает обычную ширину и не создаёт второй panel.
    isExpanded: false,
    expandedPreference: stored(DOCK_EXPANDED_KEY) === '1',
    activeTool: stored(DOCK_TOOL_KEY) || null,
    width: clampDockWidth(stored(DOCK_WIDTH_KEY, String(DEFAULT_DOCK_WIDTH))),
    mounted: {},
    intents: {},
    nextIntentId: 1,
    // Нужен только индикатору рейки; содержимое терминала сюда не попадает.
    runtime: {},
  }),
  actions: {
    rememberTool(id) {
      this.activeTool = id || null;
      try {
        if (this.activeTool) localStorage.setItem(DOCK_TOOL_KEY, this.activeTool);
        else localStorage.removeItem(DOCK_TOOL_KEY);
      } catch { /* приватный режим может запретить storage */ }
    },
    open(id) {
      const wasOpen = this.isOpen;
      this.rememberTool(id);
      this.isOpen = !!id;
      // При новом открытии восстанавливаем выбранную человеком геометрию. При
      // переключении инструмента в уже открытом доке сохраняем текущую: она
      // могла быть временно снята переходом в другой раздел.
      if (!this.isOpen) this.isExpanded = false;
      else if (!wasOpen) this.isExpanded = this.expandedPreference;
      if (id) this.mounted[id] = true;
    },
    close() {
      this.isOpen = false;
      this.isExpanded = false;
    },
    toggle(id) {
      if (this.isOpen && this.activeTool === id) this.close();
      else this.open(id);
    },
    setExpanded(value, { persist = true } = {}) {
      const expanded = !!value;
      this.isExpanded = this.isOpen && expanded;
      if (persist) {
        this.expandedPreference = expanded;
        try { localStorage.setItem(DOCK_EXPANDED_KEY, expanded ? '1' : '0'); } catch { /* ignore */ }
      }
    },
    toggleExpanded() {
      this.setExpanded(!this.isExpanded);
    },
    setMounted(id, value) {
      if (value) this.mounted[id] = true;
      else delete this.mounted[id];
    },
    setWidth(value, { max, min = MIN_DOCK_WIDTH, persist = false } = {}) {
      this.width = clampDockWidth(value, max, min);
      if (persist) {
        try { localStorage.setItem(DOCK_WIDTH_KEY, String(Math.round(this.width))); } catch { /* ignore */ }
      }
      return this.width;
    },
    enqueue(id, payload = {}) {
      const intent = { ...payload, id: this.nextIntentId++ };
      if (!this.intents[id]) this.intents[id] = [];
      this.intents[id].push(intent);
      return intent;
    },
    consume(id, intentId) {
      const queue = this.intents[id] || [];
      const index = queue.findIndex((item) => item.id === intentId);
      if (index >= 0) queue.splice(index, 1);
      if (!queue.length) delete this.intents[id];
    },
    clearIntents(id) { delete this.intents[id]; },
    setRuntime(id, value) {
      if (value == null) delete this.runtime[id];
      else this.runtime[id] = { ...(this.runtime[id] || {}), ...value };
    },
    resetRuntime(id) {
      this.setMounted(id, false);
      delete this.runtime[id];
    },
    resetAllRuntime() {
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
