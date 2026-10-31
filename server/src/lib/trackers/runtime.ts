import path from 'node:path';

import type { CredsStore } from '../b24/credsStore.ts';
import { createDriverInstallService } from '../driverInstall/service.ts';
import { createGrigdeskTasksService } from '../grigdeskTasks/service.ts';
import type { GrigdeskTasksServiceOptions } from '../grigdeskTasks/service.ts';
import { createStockTracker, STOCK_SCHEMA } from './b24Stock.ts';
import { TrackerFacade } from './facade.ts';
import { createOwnTracker } from './own.ts';
import { TrackerRegistry } from './registry.ts';
import { createSerialQueue } from './serialQueue.ts';
import { TrackerSettingsStore } from './settingsStore.ts';
import type { TrackerHost } from './contract.ts';

export interface TrackerRuntimeOptions extends Omit<GrigdeskTasksServiceOptions, 'b24'> {
  config: GrigdeskTasksServiceOptions['config'] & {
    driversDir: string;
    driverInstallsPath: string;
    trackerSettingsPath: string;
    trackerCredentialsPath: string;
    b24CookiePath: string;
    dataHome?: string;
  };
  credsStore: CredsStore;
  fetch?: typeof fetch;
  grigDeskVersion?: string;
  onChanged?: () => void | Promise<void>;
}

/**
 * Приложение и HTTP-фикстуры собирают один и тот же runtime.
 * Recovery установщика предшествует scan/import, own использует единственный ядровой сервис.
 */
export async function createTrackerRuntime(options: TrackerRuntimeOptions) {
  const { config, credsStore } = options;
  const selection = new TrackerSettingsStore(config.trackerSettingsPath, credsStore.has());

  credsStore.useTrackerCredentialsPath(config.trackerCredentialsPath);

  const hosts = new Map<string, TrackerHost>();

  /**
   * Host закрепляет реквизиты, очередь и постоянные пути за одним driver id.
   * Фабрика не получает общий store секретов или сборку HTTP-приложения.
   */
  const host = (id: string): TrackerHost => {
    let value = hosts.get(id);

    if (!value) {
      value = {
        credentials: { read: () => credsStore.readFor(id) },
        dataDir: path.join(path.dirname(config.trackerSettingsPath), 'tracker-data', id),
        cookiePath: id === 'b24-custom' ? config.b24CookiePath
          : path.join(path.dirname(config.trackerSettingsPath), 'tracker-data', id, 'cookies.json'),
        serial: createSerialQueue(),
        logger: { info: () => {}, warn: () => {} },
      };
      hosts.set(id, value);
    }

    return value;
  };
  const registry = new TrackerRegistry({ directory: config.driversDir, host });
  const b24 = new TrackerFacade({
    registry,
    selection,
  });
  const own = createGrigdeskTasksService({
    ...options,
    b24: { isConfigured: () => b24.hasSelection(), probeTaskNumber: (id) => b24.probeTaskNumber(id) },
  });
  const installs = createDriverInstallService({
    driversDir: config.driversDir,
    statePath: config.driverInstallsPath,
    grigDeskVersion: options.grigDeskVersion ?? '1.0.0',
  });

  const recovery = await installs.recover();

  registry.register(createOwnTracker(own), 'GrigDesk');
  registry.register(createStockTracker(host('b24-stock'), options.fetch), 'Битрикс24 REST', STOCK_SCHEMA);
  installs.bindRuntime({
    isLoaded: (id) => registry.isLoaded(id),
    prepareReplace: (id, signal) => registry.prepareReplace(id, signal),
    refresh: async () => {
      await registry.refresh();
      await activateSelection();
      await options.onChanged?.();
    },
  });
  await registry.refresh();

  if (recovery.blockedIds === '*') {
    for (const entry of registry.descriptors()) {
      if (!['own', 'b24-stock'].includes(entry.id)) {
        registry.unavailable(entry.id, 'Требуется восстановление установки');
      }
    }
  } else {
    for (const id of recovery.blockedIds) {
      registry.unavailable(id, 'Требуется восстановление установки');
    }
  }

  /**
   * Ограничение одного внешнего применяется к настройкам доски, а не общему реестру.
   * Недоступный выбор сохраняется, чтобы действие не сменило аккаунт незаметно.
   */
  async function activateSelection() {
    const { externalId } = selection.read();

    for (const id of registry.activeIds) {
      if (id !== externalId) {
        registry.deactivate(id);
      }
    }

    if (externalId) {
      if (registry.descriptors().find((entry) => entry.id === externalId)?.status === 'restartRequired') {
        return;
      }

      try {
        await registry.activate(externalId);
      } catch {
        registry.unavailable(externalId, 'Выбранный драйвер не настроен или недоступен');
      }
    }
  }

  await activateSelection();

  return {
    registry,
    selection,
    credsStore,
    b24,
    own,
    installs,
    activateSelection,
    writeSettings: async (externalId: string | null, changes: Record<string, Record<string, unknown>>) => {
      await registry.changeCredentials(Object.keys(changes), () => {
        for (const [id, values] of Object.entries(changes)) {
          credsStore.writeFor(id, values);
        }

        selection.write(externalId);
      });
      await activateSelection();
    },
    catalog: () => ({
      drivers: registry.descriptors(),
      activeIds: registry.activeIds,
      ...selection.read(),
    }),
    close: async () => {
      await registry.close();
      await installs.close();
    },
  };
}

export type TrackerRuntime = Awaited<ReturnType<typeof createTrackerRuntime>>;
