import { normalizeExecutorType } from '../../../../shared/chat/executorTypes.ts';
import type { AccountSnapshot, Studio3dProvider } from '../../lib/studio3d/provider.ts';

import type {
  PluginAccountSnapshot, PluginProvider,
} from '../../../../packages/plugin-types/src/provider.ts';

export type {
  PluginAccountSnapshot, PluginProvider,
} from '../../../../packages/plugin-types/src/provider.ts';

interface CapabilityAdapter {
  type?: unknown;
  studio3d?: Studio3dProvider;
}

/**
 * Фасад выдаёт только возможности 3D, удерживая исходные снимки внутри ядра.
 * WeakMap привязан к одному исполнителю одного плагина: копия снимка прав не получает.
 */
function createProviderFacade(provider: Studio3dProvider): PluginProvider {
  const snapshots = new WeakMap<PluginAccountSnapshot, AccountSnapshot>();
  const facade = {
    id: provider.id,
    name: provider.name,
    local: provider.local,
    unit: provider.unit ? Object.freeze({ ...provider.unit }) : null,
    usdPerUnit: provider.usdPerUnit,
    available: provider.available.bind(provider),
    operations: provider.operations.bind(provider),
    validate: provider.validate.bind(provider),
    quote: provider.quote.bind(provider),
  } as Omit<PluginProvider, 'snapshot'> & { snapshot?: () => PluginAccountSnapshot };

  for (const key of [
    'nativeAccepts', 'pool', 'plan', 'recognizeRecord', 'taskOperation', 'cancelReads', 'run',
  ] as const) {
    const method = provider[key];

    if (method) {
      Object.assign(facade, { [key]: method.bind(provider) });
    }
  }

  if (provider.snapshot) {
    facade.snapshot = () => {
      const original = provider.snapshot!();
      const snapshot = Object.freeze({ accountKey: original.accountKey, billingUrl: original.billingUrl });

      snapshots.set(snapshot, original);

      return snapshot;
    };
  }

  for (const key of ['isCurrent', 'balance', 'history', 'prepare', 'send', 'poll'] as const) {
    const method = provider[key];

    if (!method) {
      continue;
    }

    const position = key === 'prepare' || key === 'send' || key === 'poll' ? 1 : 0;

    Object.assign(facade, { [key]: (...args: unknown[]) => {
      const snapshot = args[position];

      if (snapshot !== undefined) {
        const original = typeof snapshot === 'object' && snapshot !== null
          ? snapshots.get(snapshot as PluginAccountSnapshot) : undefined;

        if (!original) {
          throw new TypeError('Снимок аккаунта не принадлежит этому исполнителю плагина.');
        }

        args[position] = original;
      }

      return Reflect.apply(method, provider, args);
    } });
  }

  return Object.freeze(facade);
}

/**
 * Кэш живёт в core одного плагина и сохраняет пригодность его непрозрачных снимков.
 * Состав адаптеров читается заново при каждом запросе, отдельного реестра здесь нет.
 */
export function createProviderCapabilities() {
  const cache = new WeakMap<Studio3dProvider, PluginProvider>();

  return (adapters: ReadonlyMap<string, CapabilityAdapter>, type: unknown): PluginProvider[] => {
    if (type !== '3d') {
      return [];
    }

    const result: PluginProvider[] = [];

    for (const adapter of adapters.values()) {
      if (normalizeExecutorType(adapter.type) !== '3d' || !adapter.studio3d) {
        continue;
      }

      const provider = adapter.studio3d;
      let facade = cache.get(provider);

      if (!facade) {
        facade = createProviderFacade(provider);
        cache.set(provider, facade);
      }

      result.push(facade);
    }

    return result;
  };
}
