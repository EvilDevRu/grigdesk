// Горячие клавиши инструментов — настройка УСТРОЙСТВА, как ширина дока и раскладка чата:
// клавиатура планшета, рабочего компьютера и мозга разные, и общая настройка чинила бы
// одно устройство за счёт другого. Состав инструментов сюда не дублируется — он в registry.
import { defineStore } from 'pinia';
import { TOOL_CATALOG } from '../shared/tools/catalog.ts';
import { comboIssue, normalizeCombo } from '../shared/hotkeys/combo.ts';

export const HOTKEYS_KEY = 'grigdesk-tool-hotkeys';

export const DEFAULT_HOTKEYS = Object.fromEntries(TOOL_CATALOG
  .map((item) => [item.id, normalizeCombo(item.hotkey)])
  .filter(([, combo]) => combo));

/**
 * Проверяет итоговую карту целиком, включая стандартные сочетания остальных строк.
 * Обмен клавиш двух инструментов не проходит через временный конфликт первой записи.
 */
export function validateHotkeyOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, error: 'Некорректная карта сочетаний.' };
  }

  const known = new Set(TOOL_CATALOG.map((item) => item.id));
  const normalized = {};

  for (const [id, value] of Object.entries(overrides)) {
    if (!known.has(id) || typeof value !== 'string') {
      return { ok: false, error: 'Неизвестный инструмент или сочетание.' };
    }

    const combo = value ? normalizeCombo(value) : '';
    const issue = value ? comboIssue(combo) : '';

    if (issue) {
      return { ok: false, error: issue };
    }

    normalized[id] = combo;
  }

  const owners = new Map();

  for (const item of TOOL_CATALOG) {
    const combo = Object.hasOwn(normalized, item.id) ? normalized[item.id] : DEFAULT_HOTKEYS[item.id];

    if (!combo) {
      continue;
    }

    if (owners.has(combo)) {
      return { ok: false, error: `Это сочетание уже открывает «${owners.get(combo)}».` };
    }

    owners.set(combo, item.label);
  }

  return { ok: true, overrides: normalized };
}

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
     * Заменяет полную карту одним подтверждённым действием и одной записью storage.
     * Неуспешная проверка не меняет ни работающие клавиши, ни сохранённую карту.
     */
    replaceOverrides(map) {
      const result = validateHotkeyOverrides(map);

      if (!result.ok) {
        return result;
      }

      this.overrides = result.overrides;
      persistOverrides(this.overrides);

      return result;
    },
    /**
     * Перечитывает настройки другого окна без обратной записи в storage.
     * Текущая запись сочетания остаётся в прежнем состоянии.
     */
    reload() {
      this.overrides = storedOverrides();
    },
    startRecording(id) { this.recording = id || null; },
    stopRecording() { this.recording = null; },
  },
});
