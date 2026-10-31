import path from 'node:path';

import type { TrackerCredentialsStore } from './credentialsStore.ts';
import { createDriverInstallService } from '../driverInstall/service.ts';
import { createGrigdeskTasksService } from '../grigdeskTasks/service.ts';
import type { GrigdeskTasksServiceOptions } from '../grigdeskTasks/service.ts';
import { TrackerFacade } from './facade.ts';
import { createOwnTracker } from './own.ts';
import { TrackerRegistry } from './registry.ts';
import { createSerialQueue } from './serialQueue.ts';
import { TrackerSettingsStore } from './settingsStore.ts';
import type { TrackerHost, TrackerReadTrace } from './contract.ts';
import { TrackerError } from './contract.ts';
import { installError } from '../packageInstall/errors.ts';

export interface TrackerRuntimeOptions extends Omit<GrigdeskTasksServiceOptions, 'tracker'> {
  config: GrigdeskTasksServiceOptions['config'] & {
    driversDir: string;
    driverInstallsPath: string;
    trackerSettingsPath: string;
    trackerCredentialsPath: string;
    dataHome?: string;
  };
  credsStore: TrackerCredentialsStore;
  fetch?: typeof fetch;
  traceRead?: (event: TrackerReadTrace) => void;
  grigDeskVersion?: string;
  onChanged?: () => void | Promise<void>;
}

/**
 * Приложение и HTTP-фикстуры собирают один и тот же runtime.
 * Recovery установщика предшествует scan/import, own использует единственный ядровой сервис.
 */
export async function createTrackerRuntime(options: TrackerRuntimeOptions) {
  const { config, credsStore } = options;

  credsStore.useTrackerCredentialsPath(config.trackerCredentialsPath);

  const hosts = new Map<string, TrackerHost>();
  const cookiePathFor = (id: string) => path.join(
    path.dirname(config.trackerSettingsPath), 'tracker-data', id, 'cookies.json',
  );

  /**
   * Host закрепляет реквизиты, очередь и постоянные пути за одним driver id.
   * Фабрика не получает общий store секретов или сборку HTTP-приложения.
   */
  const host = (id: string): TrackerHost => {
    let value = hosts.get(id);

    if (!value) {
      value = {
        fetch: options.fetch,
        traceRead: options.traceRead,
        credentials: { read: () => credsStore.readFor(id) },
        dataDir: path.join(path.dirname(config.trackerSettingsPath), 'tracker-data', id),
        cookiePath: cookiePathFor(id),
        serial: createSerialQueue(),
        logger: { info: () => {}, warn: () => {} },
      };
      hosts.set(id, value);
    }

    return value;
  };
  const registry = new TrackerRegistry({ directory: config.driversDir, host });
  const installs = createDriverInstallService({
    driversDir: config.driversDir,
    statePath: config.driverInstallsPath,
    grigDeskVersion: options.grigDeskVersion ?? '1.0.0',
  });

  const recovery = await installs.recover();

  // Обёртка own регистрируется до выбора внешнего подключения и создания его фасада.
  // Методы вызываются только после сборки runtime и обращаются к единственному own-сервису.
  registry.register(createOwnTracker({
    get: (id) => own.get(id),
    list: () => own.list(),
    create: (input) => own.create(input),
    listProjects: () => own.listProjects(),
  }), 'GrigDesk');
  installs.bindRuntime({
    isLoaded: (id) => registry.isLoaded(id),
    prepareReplace: async (id, signal) => {
      try {
        return await registry.prepareReplace(id, signal);
      } catch (error) {
        if (error instanceof TrackerError && error.status === 409) {
          throw installError('install_busy');
        }

        throw error;
      }
    },
    removed: (id) => registry.deleted(id),
    installed: (id) => registry.installed(id),
    refresh: async () => {
      const selected = selection.read().externalId;
      const entry = registry.descriptors().find((driver) => driver.id === selected);

      if (selected && installs.removedIds().includes(selected) && (!entry || entry.deleted)) {
        selection.write(null);
      }

      await registry.refresh();
      await activateSelection();
      await options.onChanged?.();
    },
  });
  await registry.refresh();

  if (recovery.blockedIds === '*') {
    for (const entry of registry.descriptors()) {
      if (entry.id !== 'own') {
        registry.unavailable(entry.id, 'Требуется восстановление установки');
      }
    }
  } else {
    for (const id of recovery.blockedIds) {
      registry.unavailable(id, 'Требуется восстановление установки');
    }
  }

  const selection = new TrackerSettingsStore(config.trackerSettingsPath);

  if (installs.removedIds().includes(selection.read().externalId ?? '')
    && !registry.descriptors().some((entry) => entry.id === selection.read().externalId
      && entry.status !== 'unavailable')) {
    selection.write(null);
  }

  const tracker = new TrackerFacade({ registry, selection });
  const own = createGrigdeskTasksService({
    ...options,
    tracker: {
      isConfigured: () => tracker.hasSelection(),
      probeTaskNumber: (id) => tracker.probeTaskNumber(id),
    },
  });

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
    tracker,
    own,
    installs,
    activateSelection,
    writeSettings: async (externalId: string | null, changes: Record<string, Record<string, unknown>>) => {
      await registry.changeCredentials(Object.keys(changes), () => {
        if (externalId && registry.descriptors().some((entry) => entry.id === externalId && entry.deleted)) {
          throw new TrackerError('tracker_busy', 'Драйвер удалён и требует перезапуска', 409);
        }

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
