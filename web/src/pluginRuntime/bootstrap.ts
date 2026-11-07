import { getActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { shallowRef, watch } from 'vue';
import type { Router } from 'vue-router';
import type { PluginWebModule } from '../../../shared/plugins/pluginsContracts.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import type { SseListener } from '../composables/useSse.ts';
import { useAuthStore } from '../stores/auth.ts';
import { useShellStore } from '../stores/shell.ts';
import { usePluginsStore } from '../stores/plugins.ts';
import { useDockStore } from '../stores/dock.ts';
import { currentDesktopMode } from '../shared/desktopSettings.ts';
import { setPluginAlertOpener } from '../shared/alertDeepLinks.ts';
import { launchTool } from '../shared/tools/launcher.ts';
import { t } from '../ui.ts';
import { isPluginModuleDescriptor } from './descriptor.ts';
import { createPluginRuntime } from './runtime.ts';
import type { PluginRuntime, PluginRuntimeAccess, PluginRuntimeOptions } from './runtime.ts';
import { createServerNotificationBridge } from './serverNotifications.ts';
import type { ServerNotificationBridge } from './serverNotifications.ts';
import { createPluginBackgroundCoordinator } from './background.ts';
import type { PluginBackgroundCoordinator } from './background.ts';
import type { ImportModule } from './loader.ts';

const runtimes = new WeakMap<Pinia, PluginRuntime>();
const catalogRefreshers = new WeakMap<Pinia, () => Promise<void>>();

interface CatalogEpoch {
  controller: AbortController;
  accepted: boolean;
  pending: boolean;
  refreshing: boolean;
  refreshRequested: boolean;
  snapshotRequested: boolean;
  notifications?: ServerNotificationBridge;
  background?: PluginBackgroundCoordinator;
  ready: Promise<void>;
  accept: () => void;
}

/**
 * Панель получает реестр своего приложения, а не глобальный сериализуемый store.
 * Установка в main предшествует mount, поэтому отсутствие означает ошибку композиции.
 */
export function pluginRuntimeFor(pinia = getActivePinia()): PluginRuntime {
  const runtime = pinia && runtimes.get(pinia);

  if (!runtime) {
    throw new Error(t('core.pluginModuleRuntimeMissing'));
  }

  return runtime;
}

/**
 * Route admission читает только подтверждённый допуск своего приложения.
 * Отсутствие установленного host остаётся loading без импорта или создания runtime.
 */
export function pluginRuntimeAccessFor(pinia = getActivePinia()) {
  return pinia ? runtimes.get(pinia)?.access ?? null : null;
}

/**
 * Явный повтор каталога использует signal текущей auth/access эпохи.
 * Непривязанный документ не начинает отдельное незащищённое чтение plugins.load.
 */
export function refreshPluginCatalogFor(pinia = getActivePinia()): Promise<void> {
  return pinia ? catalogRefreshers.get(pinia)?.() ?? Promise.resolve() : Promise.resolve();
}

/**
 * Новая эпоха ждёт собственный свежий каталог, даже если старый store уже loaded.
 * Отмена разблокирует ожидающие панели отказом без ожидания запоздалого HTTP-ответа.
 */
function createEpoch(): CatalogEpoch {
  const controller = new AbortController();
  let accept = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    accept = resolve;
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });

  void ready.catch(() => {});

  return {
    controller,
    accepted: false,
    pending: true,
    refreshing: false,
    refreshRequested: false,
    snapshotRequested: true,
    ready,
    accept,
  };
}

/**
 * Допуск зависит от подтверждённого входа и текущего подключения оболочки.
 * Каждая вкладка main/page владеет своим фоном; surface не импортирует его и не открывает цели.
 */
export function installPluginRuntime(pinia: Pinia, router: Router,
  options: {
    runtime?: PluginRuntime;
    chat?: PluginRuntimeOptions['chat'];
    subscribe?: (listener: SseListener) => () => void;
    backgroundImport?: ImportModule;
    loadPluginModule?: PluginRuntimeOptions['loadPluginModule'];
  } = {}): () => void {
  const auth = useAuthStore(pinia);
  const shell = useShellStore(pinia);
  const plugins = usePluginsStore(pinia);
  const dock = useDockStore(pinia);
  const backgroundWindow = currentDesktopMode() !== 'surface';
  const tracked = new Map<string, string>();
  const access = shallowRef<PluginRuntimeAccess>({ owner: null, status: 'revoked' });
  let epoch: CatalogEpoch | null = null;
  let removeCatalogEvents = () => {};
  let disposed = false;

  const permitted = () => !disposed && auth.ready && auth.authenticated && shell.initialized
    && (!shell.present || shell.status === 'online');
  const ownerKey = () => JSON.stringify([auth.clientScope, auth.logEpoch, shell.profile?.id ?? null]);
  const runtime = options.runtime ?? createPluginRuntime({
    plugins,
    router,
    dock,
    chat: options.chat,
    access,
    loadPluginModule: options.loadPluginModule,
    backgroundReady: async (id) => {
      const current = epoch;

      if (!current || !permitted()) {
        throw new Error(t('core.pluginModuleAccessRevoked'));
      }

      await current.ready;
      current.controller.signal.throwIfAborted();

      if (!current.background) {
        throw new Error(t('core.pluginModuleAccessRevoked'));
      }

      await current.background.ready(id);
    },
    isAvailable: () => permitted() && epoch?.accepted === true,
    waitForAccess: async () => {
      const current = epoch;

      if (!permitted() || !current) {
        throw new Error(t('core.pluginModuleAccessRevoked'));
      }

      await current.ready;
      current.controller.signal.throwIfAborted();
    },
  });

  runtime.access ??= access;
  runtimes.set(pinia, runtime);

  /**
   * Потеря допуска немедленно отзывает и фон, и записи закрытых панелей.
   * Список идентификаторов сохраняется отдельно от обновляемого каталога.
   */
  function revoke(): void {
    removeCatalogEvents();
    removeCatalogEvents = () => {};
    epoch?.controller.abort();
    epoch = null;

    if (runtime.reset) {
      runtime.reset();
    } else {
      for (const id of tracked.keys()) {
        runtime.stop(id);
      }
    }

    tracked.clear();
  }

  /**
   * Сопоставляем только подтверждённый снимок и не перезапускаем hook от values или языка.
   * Удаление, выключение и новый дескриптор отзывают прежнюю запись до запуска замены.
   */
  function reconcile(snapshot: typeof plugins.list): void {
    if (!permitted() || !epoch?.accepted) {
      return;
    }

    const modules = new Map<string, PluginWebModule>();

    for (const plugin of snapshot) {
      if (plugin.enabled && plugin.compatibility?.status !== 'incompatible'
        && !plugin.system && isPluginModuleDescriptor(plugin.id, plugin.entrypoints?.web)) {
        modules.set(plugin.id, plugin.entrypoints?.web);
      }
    }

    for (const [id, previous] of tracked) {
      if (JSON.stringify(modules.get(id)) !== previous) {
        runtime.stop(id);
        tracked.delete(id);
      }
    }

    for (const [id, descriptor] of modules) {
      if (tracked.has(id)) {
        continue;
      }

      tracked.set(id, JSON.stringify(descriptor));
    }

    epoch.notifications?.acceptCatalog(snapshot);
    epoch.background?.acceptCatalog(snapshot);
  }

  /**
   * Сигналы каталога объединяются в одной попытке с повтором после последнего изменения.
   * Вытеснение повторяется в живой эпохе, сетевой отказ сам не создаёт нового запроса.
   */
  async function refresh(current: CatalogEpoch, snapshotRequested = false): Promise<void> {
    current.snapshotRequested ||= snapshotRequested;

    if (current.refreshing) {
      current.refreshRequested = true;

      return;
    }

    current.refreshing = true;

    try {
      do {
        current.refreshRequested = false;

        const result = await plugins.load({ signal: current.controller.signal });

        if (current !== epoch || current.controller.signal.aborted) {
          return;
        }
        if (result.outcome === 'superseded') {
          current.refreshRequested = true;

          continue;
        }

        current.pending = false;

        if (result.outcome === 'accepted') {
          current.accepted = true;
          current.accept();
          reconcile(result.plugins);
          access.value = { owner: access.value.owner, status: 'ready' };

          if (current.snapshotRequested) {
            current.snapshotRequested = false;
            void current.notifications?.refresh();
          }
        }
      } while (current.refreshRequested && !current.controller.signal.aborted);
    } finally {
      current.refreshing = false;
    }
  }

  const refreshCatalog = async () => {
    const current = epoch;

    if (current && permitted()) {
      await refresh(current);
    }
  };

  catalogRefreshers.set(pinia, refreshCatalog);

  const removeOwnerWatch = watch(() => JSON.stringify([
    ownerKey(), auth.ready, auth.authenticated, permitted(), permitted() ? null : shell.status,
  ]), () => {
    const owner = JSON.stringify([auth.clientScope, shell.profile?.id ?? null]);
    const online = permitted();
    const transient = shell.present && ['connecting', 'offline', 'locked'].includes(shell.status);
    const reconnecting = shell.present && shell.status === 'online' && access.value.status === 'suspended';
    const suspended = owner === access.value.owner && !online && (transient || reconnecting);

    // Оболочка сбрасывает auth и logEpoch при обрыве: сохраняем только UI того же scope/profile.
    // Права всё равно отзываются ниже; до нового входа и свежего каталога context остаётся aborted.
    access.value = {
      owner: online || suspended ? owner : null,
      status: online ? 'waiting' : suspended ? 'suspended' : 'revoked',
    };
    revoke();

    if (online && backgroundWindow) {
      const current = createEpoch();
      const clientScope = auth.clientScope;

      epoch = current;
      current.notifications = createServerNotificationBridge({
        owner,
        clientScope,
        signal: current.controller.signal,
        isCurrent: () => epoch === current && current.accepted && permitted()
          && auth.clientScope === clientScope && access.value.owner === owner,
      });
      current.background = createPluginBackgroundCoordinator({
        plugins,
        signal: current.controller.signal,
        importModule: options.backgroundImport,
        isCurrent: () => epoch === current && current.accepted && permitted()
          && auth.clientScope === clientScope && access.value.owner === owner,
      });
      removeCatalogEvents = options.subscribe?.((name, data) => {
        current.notifications?.onEvent(name, data);

        if (epoch === current && permitted()
          && (name === 'hello' || name === 'state-change' && isRecord(data) && data.plugins === true)) {
          void refresh(current, name === 'hello');
        }
      }) ?? (() => {});
      void refresh(current);
    }
  }, { immediate: true, flush: 'sync' });

  const removeCatalogWatch = watch([() => plugins.list, () => JSON.stringify(plugins.list.map((plugin) => ({
    id: plugin.id,
    enabled: plugin.enabled,
    system: plugin.system,
    web: plugin.entrypoints?.web,
    compatibility: plugin.compatibility,
    generation: plugin.runtimeGeneration,
  })))], () => {
    if (epoch && !epoch.pending) {
      epoch.accepted = true;
      epoch.accept();
      reconcile(plugins.list);
      access.value = { owner: access.value.owner, status: 'ready' };
    }
  }, { flush: 'sync' });

  const removeOpener = backgroundWindow ? setPluginAlertOpener(async (id, params = {}) => {
    const plugin = plugins.byId(id);

    if (!permitted() || !epoch?.accepted || !plugin?.enabled || plugin.system
      || !isPluginModuleDescriptor(id, plugin.entrypoints?.web)) {
      return false;
    }

    return launchTool({
      route: router.currentRoute.value,
      router,
      dock,
    }, id, { type: 'open', params });
  }) : () => {};

  return () => {
    if (disposed) {
      return;
    }

    disposed = true;
    access.value = { owner: null, status: 'revoked' };
    removeOwnerWatch();
    removeCatalogWatch();
    removeOpener();
    revoke();
    runtime.dispose();

    if (runtimes.get(pinia) === runtime) {
      runtimes.delete(pinia);
    }

    if (catalogRefreshers.get(pinia) === refreshCatalog) {
      catalogRefreshers.delete(pinia);
    }
  };
}
