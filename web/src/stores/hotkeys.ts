import { defineStore } from 'pinia';

import { type LocaleSource, localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { isInstallPluginId } from '../../../shared/plugins/pluginInstallValues.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';
import { TOOL_CATALOG } from '../shared/tools/catalog.ts';
import { comboIssue, normalizeCombo } from '../shared/hotkeys/combo.ts';
import { resolveHotkeyAssignments, selectHotkeyMetadata } from '../shared/tools/hotkeyMetadata.ts';
import type { HotkeyAssignment, HotkeyToolMetadata } from '../shared/tools/hotkeyMetadata.ts';
import { usePluginsStore } from './plugins.ts';

type HotkeyValidation = { ok: false; error: string } | {
  ok: true;
  overrides: Record<string, string>;
};

interface HotkeysState {
  overrides: Record<string, string>;
  recording: string | null;
}

export const HOTKEYS_KEY = 'grigdesk-tool-hotkeys';

const builtinMetadata = () => selectHotkeyMetadata(TOOL_CATALOG, { loaded: false, list: [] });

// Совместимый экспорт прежних builtin defaults получается тем же metadata selector.
// Настройки и runtime используют живой каталог store, а не эту статическую проекцию.
export const DEFAULT_HOTKEYS: Record<string, string> = Object.fromEntries(builtinMetadata()
  .filter((item) => item.defaultCombo).map((item) => [item.id, item.defaultCombo]));

/**
 * Полная карта допускает валидные id ещё не установленных панелей без потери выбора.
 * Конфликтуют два явных назначения, а default уступает выбору человека в общем selector.
 */
export function validateHotkeyOverrides(
  overrides: unknown,
  locale: LocaleSource = 'ru',
  metadata: readonly HotkeyToolMetadata[] = builtinMetadata(),
): HotkeyValidation {
  const t = localeTranslator(locale);

  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, error: t('settings.hotkeysInvalidMap') };
  }

  const normalized: Record<string, string> = {};
  const owners = new Map<string, string>();

  for (const [id, value] of Object.entries(overrides)) {
    if (!isInstallPluginId(id) || typeof value !== 'string') {
      return { ok: false, error: t('settings.hotkeysUnknownTool') };
    }

    const combo = value ? normalizeCombo(value) : '';
    const issue = value ? comboIssue(combo, locale) : '';

    if (issue) {
      return { ok: false, error: issue };
    }

    if (combo && owners.has(combo)) {
      const owner = owners.get(combo)!;

      return {
        ok: false,
        error: t('settings.hotkeysDuplicate', {
          name: metadata.find((item) => item.id === owner)?.label ?? owner,
        }),
      };
    }

    if (combo) {
      owners.set(combo, id);
    }

    normalized[id] = combo;
  }

  return { ok: true, overrides: normalized };
}

/**
 * Чтение сохраняет неизвестные пока панели и явное выключение пустой строкой.
 * Повреждённое отдельное значение отбрасывается без потери остальных записей.
 */
function storedOverrides(fallback: Record<string, string> = {}): Record<string, string> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(localStorage.getItem(HOTKEYS_KEY) || 'null');
  } catch {
    return { ...fallback };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const overrides: Record<string, string> = {};

  for (const [id, value] of Object.entries(parsed)) {
    if (!isInstallPluginId(id) || typeof value !== 'string') {
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
 * Сохраняет подтверждённую карту сочетаний одним снимком устройства.
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
    recording: null,
  }),
  getters: {
    metadata(): HotkeyToolMetadata[] {
      const plugins = usePluginsStore();

      return selectHotkeyMetadata(TOOL_CATALOG, plugins);
    },
    rows(): HotkeyAssignment[] {
      return resolveHotkeyAssignments(this.metadata, this.overrides);
    },
    rowsFor(): (map: Readonly<Record<string, string>>) => HotkeyAssignment[] {
      return (map) => resolveHotkeyAssignments(this.metadata, map);
    },
    comboOf(): (id: string) => string {
      return (id) => this.rows.find((item) => item.id === id)?.combo ?? this.overrides[id] ?? '';
    },
    isDefault: (state) => (id: string) => !Object.hasOwn(state.overrides, id),
    bindings(): Array<{ id: string; combo: string }> {
      return this.rows.filter((item) => item.activeCombo).map((item) => ({
        id: item.id,
        combo: item.activeCombo,
      }));
    },
    toolByCombo(): Record<string, string> {
      return Object.fromEntries(this.bindings.map(({ id, combo }) => [combo, id]));
    },
  },
  actions: {
    /**
     * UI, adapter и Apply проверяют одну карту с тем же текущим metadata каталогом.
     * Запись других строк не удаляет overrides отсутствующих или несовместимых пакетов.
     */
    validateOverrides(map: unknown, locale: LocaleSource = uiLocalePort.value): HotkeyValidation {
      const checked = validateHotkeyOverrides(map, locale, this.metadata);

      if (!checked.ok) {
        return checked;
      }

      const known = new Set(this.metadata.map((item) => item.id));
      const unknown = Object.fromEntries(Object.entries(this.overrides).filter(([id]) => !known.has(id)));

      return validateHotkeyOverrides({ ...unknown, ...checked.overrides }, locale, this.metadata);
    },
    /**
     * Принятая полная карта меняется атомарно после общей проверки explicit конфликтов.
     * Отказ сохраняет прежние bindings и persistent данные без частичной записи.
     */
    replaceOverrides(map: unknown): HotkeyValidation {
      const result = this.validateOverrides(map);

      if (!result.ok) {
        return result;
      }

      this.overrides = result.overrides;
      persistOverrides(this.overrides);

      return result;
    },
    reload(): void {
      this.overrides = storedOverrides(this.overrides);
    },
    startRecording(id: string | null | undefined): void {
      this.recording = id || null;
    },
    stopRecording(): void {
      this.recording = null;
    },
  },
});
