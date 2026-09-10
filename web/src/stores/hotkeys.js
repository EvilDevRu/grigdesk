// Горячие клавиши инструментов — настройка УСТРОЙСТВА, как ширина дока и раскладка чата:
// клавиатура планшета, рабочего компьютера и мозга разные, и общая настройка чинила бы
// одно устройство за счёт другого. Состав инструментов сюда не дублируется — он в registry.
import { defineStore } from 'pinia';
import { TOOL_CATALOG } from '../shared/tools/catalog.ts';
import { comboIssue, normalizeCombo } from '../shared/hotkeys/combo.ts';

export const HOTKEYS_KEY = 'cockpit-tool-hotkeys';

export const DEFAULT_HOTKEYS = Object.fromEntries(TOOL_CATALOG
  .map((item) => [item.id, normalizeCombo(item.hotkey)])
  .filter(([, combo]) => combo));

/**
 * Читает device-local переопределения. Пустая строка значит осознанно выключенную
 * клавишу, отсутствие ключа — сочетание по умолчанию; различать их обязательно,
 * иначе выключенный инструмент вернул бы себе клавишу при следующем открытии.
 */
function storedOverrides() {
  let parsed = null;
  try {
    parsed = JSON.parse(localStorage.getItem(HOTKEYS_KEY) || 'null');
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const known = new Set(TOOL_CATALOG.map((item) => item.id));
  const overrides = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!known.has(id) || typeof value !== 'string') continue;
    const combo = value ? normalizeCombo(value) : '';
    if (value && (!combo || comboIssue(combo))) continue;
    overrides[id] = combo;
  }

  return overrides;
}

function persistOverrides(overrides) {
  try {
    localStorage.setItem(HOTKEYS_KEY, JSON.stringify(overrides));
  } catch { /* приватный режим может запретить storage */ }
}

export const useHotkeysStore = defineStore('hotkeys', {
  state: () => ({
    overrides: storedOverrides(),
    // Пока идёт запись нового сочетания, глобальный слушатель обязан молчать:
    // иначе нажатая комбинация одновременно открыла бы панель.
    recording: null,
  }),
  getters: {
    comboOf: (state) => (id) => (
      Object.hasOwn(state.overrides, id) ? state.overrides[id] : (DEFAULT_HOTKEYS[id] || '')
    ),
    isDefault: (state) => (id) => !Object.hasOwn(state.overrides, id),
    bindings() {
      return TOOL_CATALOG.map((item) => ({ id: item.id, combo: this.comboOf(item.id) }));
    },
    // Обратный индекс для слушателя: на каждое нажатие ищем строкой, а не перебором.
    toolByCombo() {
      const index = {};
      for (const { id, combo } of this.bindings) {
        if (combo && !index[combo]) index[combo] = id;
      }
      return index;
    },
  },
  actions: {
    /**
     * Назначает сочетание инструменту. Отказ возвращается текстом для человека:
     * системные комбинации до страницы не доходят, а дубль тихо увёл бы клавишу
     * у соседней панели.
     */
    assign(id, value) {
      const combo = normalizeCombo(value);
      const issue = comboIssue(combo);
      if (issue) return { ok: false, error: issue };

      const busy = this.toolByCombo[combo];
      if (busy && busy !== id) {
        const label = TOOL_CATALOG.find((item) => item.id === busy)?.label || busy;
        return { ok: false, error: `Это сочетание уже открывает «${label}».` };
      }

      this.overrides = { ...this.overrides, [id]: combo };
      persistOverrides(this.overrides);
      return { ok: true, combo };
    },
    disable(id) {
      this.overrides = { ...this.overrides, [id]: '' };
      persistOverrides(this.overrides);
    },
    restore(id) {
      const overrides = { ...this.overrides };
      delete overrides[id];
      this.overrides = overrides;
      persistOverrides(this.overrides);
    },
    resetAll() {
      this.overrides = {};
      persistOverrides(this.overrides);
    },
    startRecording(id) { this.recording = id || null; },
    stopRecording() { this.recording = null; },
  },
});
