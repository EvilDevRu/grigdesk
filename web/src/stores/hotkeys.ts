import { defineStore } from 'pinia';
import { type LocaleSource, localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';
import { TOOL_CATALOG } from '../shared/tools/catalog.ts';
import { comboIssue, normalizeCombo } from '../shared/hotkeys/combo.ts';

type HotkeyValidation = { ok: false; error: string } | {
  ok: true;
  overrides: Record<string, string>;
};

interface HotkeysState {
  overrides: Record<string, string>;
  recording: string | null;
}

// Горячие клавиши инструментов — настройка УСТРОЙСТВА, как ширина дока и раскладка чата:
// клавиатура планшета, рабочего компьютера и мозга разные, и общая настройка чинила бы
// одно устройство за счёт другого. Состав инструментов сюда не дублируется — он в registry.

export const HOTKEYS_KEY = 'grigdesk-tool-hotkeys';

export const DEFAULT_HOTKEYS: Record<string, string> = Object.fromEntries(TOOL_CATALOG
  .map((item) => [item.id, normalizeCombo(item.hotkey)])
  .filter(([, combo]) => combo));

/**
 * Проверяет итоговую карту целиком, включая стандартные сочетания остальных строк.
 * Обмен клавиш двух инструментов не проходит через временный конфликт первой записи.
 */
export function validateHotkeyOverrides(overrides: unknown, locale: LocaleSource = 'ru'): HotkeyValidation {
  const t = localeTranslator(locale);

  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, error: t('settings.hotkeysInvalidMap') };
  }

  const known = new Set(TOOL_CATALOG.map((item) => item.id));
  const normalized: Record<string, string> = {};

  for (const [id, value] of Object.entries(overrides)) {
    if (!known.has(id) || typeof value !== 'string') {
      return { ok: false, error: t('settings.hotkeysUnknownTool') };
    }

    const combo = value ? normalizeCombo(value) : '';
    const issue = value ? comboIssue(combo, locale) : '';

    if (issue) {
      return { ok: false, error: issue };
    }

    normalized[id] = combo;
  }

  const owners = new Map<string, string>();

  for (const item of TOOL_CATALOG) {
    const combo = Object.hasOwn(normalized, item.id) ? normalized[item.id] : DEFAULT_HOTKEYS[item.id];

    if (!combo) {
      continue;
    }

    if (owners.has(combo)) {
      return { ok: false, error: t('settings.hotkeysDuplicate', { name: owners.get(combo) }) };
    }

    owners.set(combo, t(`core.builtinNavigation.${item.id}`));
  }

  return { ok: true, overrides: normalized };
}

/**
 * Читает device-local переопределения. Пустая строка значит осознанно выключенную
 * клавишу, отсутствие ключа — сочетание по умолчанию; различать их обязательно,
 * иначе выключенный инструмент вернул бы себе клавишу при следующем открытии.
 */
function storedOverrides(): Record<string, string> {
  let parsed: unknown = null;

  try {
    parsed = JSON.parse(localStorage.getItem(HOTKEYS_KEY) || 'null');
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const known = new Set(TOOL_CATALOG.map((item) => item.id));
  const overrides: Record<string, string> = {};

  for (const [id, value] of Object.entries(parsed)) {
    if (!known.has(id) || typeof value !== 'string') {
      continue;
    }

    const combo = value ? normalizeCombo(value) : '';

    if (value && (!combo || comboIssue(combo))) {
      continue;
    }

    overrides[id] = combo;
  }


  return overrides;
}

/**
 * Сохраняет подтверждённую карту сочетаний одним снимком.
 * Недоступный storage не отменяет работающие привязки текущего окна.
 */
function persistOverrides(overrides: Record<string, string>): void {
  try {
    localStorage.setItem(HOTKEYS_KEY, JSON.stringify(overrides));
  } catch {
    // Приватный режим может запретить storage.
  }
}

export const useHotkeysStore = defineStore('hotkeys', {
  state: (): HotkeysState => ({
    overrides: storedOverrides(),
    // Пока идёт запись нового сочетания, глобальный слушатель обязан молчать:
    // иначе нажатая комбинация одновременно открыла бы панель.
    recording: null,
  }),
  getters: {
    comboOf: (state) => (id: string) => (
      Object.hasOwn(state.overrides, id) ? state.overrides[id] : (DEFAULT_HOTKEYS[id] || '')
    ),
    isDefault: (state) => (id: string) => !Object.hasOwn(state.overrides, id),
    bindings(): Array<{ id: string; combo: string | undefined }> {
      return TOOL_CATALOG.map((item) => ({ id: item.id, combo: this.comboOf(item.id) }));
    },
    // Обратный индекс для слушателя: на каждое нажатие ищем строкой, а не перебором.
    // Обратный индекс использует только первое допустимое назначение сочетания.
    // Так обработчик нажатия не перебирает каталог инструментов заново.
    toolByCombo(): Record<string, string> {
      const index: Record<string, string> = {};

      for (const { id, combo } of this.bindings) {
        if (combo && !index[combo]) {
          index[combo] = id;
        }
      }

      return index;
    },
  },
  actions: {
    /**
     * Заменяет полную карту одним подтверждённым действием и одной записью storage.
     * Неуспешная проверка не меняет ни работающие клавиши, ни сохранённую карту.
     */
    replaceOverrides(map: unknown): HotkeyValidation {
      const result = validateHotkeyOverrides(map, uiLocalePort.value);

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
    reload(): void {
      this.overrides = storedOverrides();
    },
    startRecording(id: string | null | undefined): void {
      this.recording = id || null;
    },
    stopRecording(): void {
      this.recording = null;
    },
  },
});
