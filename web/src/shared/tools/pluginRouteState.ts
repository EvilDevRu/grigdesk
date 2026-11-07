import type { PluginListItem } from '../../../../shared/plugins/pluginsContracts.ts';
import { isPluginModuleDescriptor } from '../../pluginRuntime/descriptor.ts';

type PluginCard = Pick<PluginListItem, 'id' | 'name' | 'enabled'> & Partial<PluginListItem>;

export type PluginRouteStatus = 'loading' | 'load-error' | 'missing'
  | 'incompatible' | 'disabled' | 'no-panel' | 'ready';

export interface PluginRouteState {
  status: PluginRouteStatus;
  label: string;
  reason: string | null;
}

const state = (status: PluginRouteStatus, label: string, reason: string | null = null): PluginRouteState => ({
  status,
  label,
  reason,
});

/**
 * Retained metadata не подтверждает свежую auth/access эпоху.
 * Внешний route смотрит весь каталог и никогда не подставляет одноимённый builtin.
 */
export function resolvePluginRouteState(id: string, catalog: {
  list: readonly PluginCard[];
  loaded: boolean;
  loadError?: string | null;
  accepted: boolean;
}): PluginRouteState {
  if (catalog.loadError) {
    return state('load-error', id, catalog.loadError);
  }

  if (!catalog.loaded || !catalog.accepted) {
    return state('loading', id);
  }

  const plugin = catalog.list.find((item) => item.id === id && !item.system);

  if (!plugin) {
    return state('missing', id);
  }

  const label = plugin.name || id;

  if (plugin.compatibility?.status === 'incompatible') {
    return state('incompatible', label, plugin.compatibility.reason);
  }

  if (!plugin.contributes?.panels?.length || !isPluginModuleDescriptor(id, plugin.entrypoints?.web)) {
    return state('no-panel', label, plugin.serverError ?? null);
  }

  return state(plugin.enabled ? 'ready' : 'disabled', label);
}
