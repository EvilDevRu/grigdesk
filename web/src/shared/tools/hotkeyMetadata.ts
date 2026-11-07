import { comboIssueKey, isCanonicalPanelHotkey, normalizeCombo } from '../../../../shared/hotkeys/combo.ts';
import { isInstallPluginId } from '../../../../shared/plugins/pluginInstallValues.ts';
import type { PluginListItem } from '../../../../shared/plugins/pluginsContracts.ts';
import { isPluginModuleDescriptor } from '../../pluginRuntime/descriptor.ts';

interface BuiltinMetadata {
  id: string;
  label: string;
  hotkey: string;
  plugin?: string;
}

type PluginCard = Pick<PluginListItem, 'id' | 'name' | 'enabled'> & Partial<PluginListItem>;

export interface HotkeyToolMetadata {
  id: string;
  label: string;
  defaultCombo: string;
  external: boolean;
  availability: 'enabled' | 'disabled' | 'pending';
}

export interface HotkeyAssignment extends HotkeyToolMetadata {
  combo: string;
  isDefault: boolean;
  activeCombo: string;
  shadowedBy: string | null;
  shadowedLabel: string | null;
}

/**
 * Каталог клавиш содержит только подписи и декларации, без загрузки компонентов.
 * Disabled панели остаются строками настроек, а недоверенный default проверяется повторно.
 */
export function selectHotkeyMetadata(
  builtins: readonly BuiltinMetadata[],
  catalog: { loaded: boolean; list: readonly PluginCard[] },
): HotkeyToolMetadata[] {
  const builtinIds = new Set(builtins.map((item) => item.id));
  const metadata: HotkeyToolMetadata[] = builtins.map((item) => ({
    id: item.id,
    label: item.label,
    defaultCombo: isCanonicalPanelHotkey(item.hotkey) ? item.hotkey : '',
    external: false,
    availability: !item.plugin ? 'enabled' : !catalog.loaded ? 'pending'
      : catalog.list.some((plugin) => plugin.id === item.plugin && plugin.enabled) ? 'enabled' : 'disabled',
  }));
  const panels = catalog.list.filter((plugin) => !plugin.system && isInstallPluginId(plugin.id)
    && !builtinIds.has(plugin.id) && plugin.compatibility?.status !== 'incompatible'
    && isPluginModuleDescriptor(plugin.id, plugin.entrypoints?.web)
    && Array.isArray(plugin.contributes?.panels) && plugin.contributes.panels.length > 0);

  for (const plugin of panels.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
    const hotkey = plugin.contributes?.panels?.[0]?.hotkey;

    metadata.push({
      id: plugin.id,
      label: plugin.nav?.label || plugin.name,
      defaultCombo: isCanonicalPanelHotkey(hotkey) ? hotkey : '',
      external: true,
      availability: !catalog.loaded ? 'pending' : plugin.enabled ? 'enabled' : 'disabled',
    });
  }

  return metadata;
}

/**
 * Одну комбинацию получает один владелец: explicit, затем builtin default, затем external id.
 * Отсутствующая панель не получает binding; её сохранённый override остаётся данными устройства.
 */
export function resolveHotkeyAssignments(
  metadata: readonly HotkeyToolMetadata[],
  overrides: Readonly<Record<string, string>>,
): HotkeyAssignment[] {
  const rows = metadata.map((item): HotkeyAssignment => {
    const isDefault = !Object.hasOwn(overrides, item.id);
    const value = isDefault ? item.defaultCombo : overrides[item.id];
    const combo = value ? normalizeCombo(value) : '';

    return {
      ...item,
      combo,
      isDefault,
      activeCombo: '',
      shadowedBy: null,
      shadowedLabel: null,
    };
  });
  const priority = (item: HotkeyAssignment) => !item.isDefault ? 0 : item.external ? 2 : 1;
  const candidates = rows.filter((item) => item.combo && !comboIssueKey(item.combo)).sort((left, right) =>
    priority(left) - priority(right) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const owners = new Map<string, HotkeyAssignment>();

  for (const item of candidates) {
    const owner = owners.get(item.combo);

    if (owner) {
      item.shadowedBy = owner.id;
      item.shadowedLabel = owner.label;
    } else {
      owners.set(item.combo, item);
      item.activeCombo = item.availability === 'enabled' ? item.combo : '';
    }
  }

  return rows;
}
