import type {
  PluginBackgroundContext,
  PluginBackgroundStart,
  PluginModuleCleanup,
} from '../../../packages/plugin-types/src/web.ts';
import type { PluginListItem, PluginWebModule } from '../../../shared/plugins/pluginsContracts.ts';
import { messageRef } from '../../../shared/i18n/core.ts';
import { alertUser, dismissAlertScope } from '../shared/alerts.ts';
import { createPluginAlerts } from './alerts.ts';
import { createPluginContext } from './context.ts';
import { isPluginModuleDescriptor } from './descriptor.ts';
import { PluginModuleError, sharedRuntime } from './loader.ts';
import type { ImportModule } from './loader.ts';

type PluginCard = Pick<PluginListItem, 'id' | 'name' | 'enabled'> & Partial<PluginListItem>;

interface BackgroundEntry {
  plugin: PluginCard;
  key: string;
  controller: AbortController;
  status: 'loading' | 'ready' | 'failed';
  stopped: boolean;
  cleanupCalled: boolean;
  cleanup?: PluginModuleCleanup;
  pending: Promise<void>;
}

const nativeImport: ImportModule = (specifier) => import(/* @vite-ignore */ specifier);
const scopeOf = (id: string) => `plugin-background:${encodeURIComponent(id)}`;

/**
 * Карта модулей и независимый background entry имеют общий ограниченный срок.
 * CSS и panel entry этот загрузчик никогда не запрашивает.
 */
export async function loadPluginBackground(pluginId: string, descriptor: PluginWebModule, options: {
  signal: AbortSignal;
  importModule?: ImportModule;
}): Promise<PluginBackgroundStart> {
  if (!isPluginModuleDescriptor(pluginId, descriptor) || !descriptor.background) {
    throw new PluginModuleError('load-failed');
  }

  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  const importModule = options.importModule ?? nativeImport;
  let removeAbort = () => {};

  options.signal.throwIfAborted();
  options.signal.addEventListener('abort', abort, { once: true });

  const timer = setTimeout(() => controller.abort(new PluginModuleError('load-failed')), 30_000);
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(controller.signal.reason);

    controller.signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', onAbort);
  });
  /**
   * Фоновый entry исполняется только после успешной общей identity проверки.
   * Отмена между await запрещает вызов start устаревшего модуля.
   */
  const load = async () => {
    await sharedRuntime(importModule);
    controller.signal.throwIfAborted();

    const module = await importModule(descriptor.background!);

    controller.signal.throwIfAborted();

    if (typeof module.start !== 'function') {
      throw new PluginModuleError('load-failed');
    }

    return module.start as PluginBackgroundStart;
  };

  try {
    return await Promise.race([load(), aborted]);
  } finally {
    clearTimeout(timer);
    removeAbort();
    options.signal.removeEventListener('abort', abort);
  }
}

/**
 * Один coordinator принадлежит подтверждённой auth/access эпохе оболочки.
 * Панель ожидает ту же запись, а её последний release не завершает этот фон.
 */
export function createPluginBackgroundCoordinator(options: {
  signal: AbortSignal;
  isCurrent(): boolean;
  plugins: { byId(id: string): PluginCard | null };
  importModule?: ImportModule;
}) {
  const entries = new Map<string, BackgroundEntry>();
  let disposed = false;
  const alive = () => !disposed && !options.signal.aborted && options.isCurrent();

  /**
   * Срок записи заканчивается до пользовательского cleanup.
   * Поздний async результат выполнит собственный cleanup ровно один раз.
   */
  function cleanup(entry: BackgroundEntry, value = entry.cleanup): void {
    if (entry.cleanupCalled || typeof value !== 'function') {
      return;
    }

    entry.cleanupCalled = true;
    entry.cleanup = undefined;

    try {
      value();
    } catch {
      // Ошибка доверенного cleanup не возвращает отозванный доступ.
    }
  }

  /**
   * Старый signal отзывается до создания записи следующего поколения.
   * Его поздний facade.clear уже не сможет снять новый background scope.
   */
  function stop(id: string): void {
    const entry = entries.get(id);

    if (!entry) {
      return;
    }

    entries.delete(id);
    entry.stopped = true;
    entry.controller.abort();
    cleanup(entry);
    dismissAlertScope(scopeOf(id));
  }

  /**
   * Ошибка не перезапускается сама при очередном таком же каталоге.
   * Человек может повторить попытку; reconnect создаёт новую access эпоху.
   */
  function reportFailure(entry: BackgroundEntry): void {
    if (!alive() || entries.get(entry.plugin.id) !== entry || entry.stopped) {
      return;
    }

    alertUser({
      id: `${scopeOf(entry.plugin.id)}:start-error`,
      scope: scopeOf(entry.plugin.id),
      title: messageRef('core.pluginBackgroundLoadFailed', { name: entry.plugin.name }),
      tone: 'warning',
      sticky: true,
      actions: [{
        id: 'retry',
        label: messageRef('core.pluginNotificationsRetry'),
        run: () => ready(entry.plugin.id).catch(() => {}),
      }],
    });
  }

  /**
   * Подготовка контекста читает только локали и readonly настройки общего API.
   * Start получает отдельный signal и alerts, без событий/панели/Pinia.
   */
  function start(plugin: PluginCard, key: string): BackgroundEntry {
    stop(plugin.id);

    const controller = new AbortController();
    const entry: BackgroundEntry = {
      plugin,
      key,
      controller,
      status: 'loading',
      stopped: false,
      cleanupCalled: false,
      pending: Promise.resolve(),
    };
    const isAlive = () => alive() && entries.get(plugin.id) === entry && !entry.stopped
      && !controller.signal.aborted;

    entries.set(plugin.id, entry);
    entry.pending = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();

        const descriptor = plugin.entrypoints!.web!;
        const hook = await loadPluginBackground(plugin.id, descriptor, {
          signal: controller.signal,
          importModule: options.importModule,
        });
        const base = await createPluginContext(plugin.id, descriptor, {
          byId: (id) => isAlive() ? options.plugins.byId(id) : null,
        }, { signal: controller.signal });

        controller.signal.throwIfAborted();

        const context: PluginBackgroundContext = {
          ...base,
          signal: controller.signal,
          alerts: createPluginAlerts(plugin.id, {
            signal: controller.signal,
            isAlive,
            kind: 'plugin-background',
          }),
        };
        const result = await hook(context);

        if (!isAlive()) {
          cleanup(entry, typeof result === 'function' ? result : undefined);
          controller.signal.throwIfAborted();

          throw new PluginModuleError('load-failed');
        }

        entry.cleanup = typeof result === 'function' ? result : undefined;
        entry.status = 'ready';
      } catch (error) {
        if (entries.get(plugin.id) === entry && !entry.stopped) {
          entry.status = 'failed';
          controller.abort();
          reportFailure(entry);
        }

        throw error;
      }
    });
    void entry.pending.catch(() => {});

    return entry;
  }

  /**
   * Ожидающие панели получают отказ сразу после отзыва, даже если start ещё занят.
   * Сам start продолжает только собственную позднюю очистку, не удерживая новый контекст.
   */
  function waitForEntry(entry: BackgroundEntry): Promise<void> {
    const signal = entry.controller.signal;

    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }

    let removeAbort = () => {};
    const aborted = new Promise<never>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);

      signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', onAbort);
    });

    return Promise.race([entry.pending, aborted]).finally(removeAbort);
  }

  /**
   * Явный ready разделяет pending/готовый start и повторяет лишь завершившийся отказ.
   * Проверка текущей карточки не допускает запуск после off/removal/отзыва auth.
   */
  function ready(id: string): Promise<void> {
    const plugin = options.plugins.byId(id);
    const descriptor = plugin?.entrypoints?.web;

    if (!alive() || !plugin?.enabled || plugin.system
      || plugin.compatibility?.status === 'incompatible'
      || typeof plugin.runtimeGeneration !== 'string' || !plugin.runtimeGeneration
      || !isPluginModuleDescriptor(id, descriptor) || !descriptor.background) {
      return Promise.reject(new PluginModuleError('load-failed'));
    }

    const key = JSON.stringify([plugin.runtimeGeneration, descriptor]);
    const previous = entries.get(id);

    if (previous?.key === key && previous.status !== 'failed') {
      return waitForEntry(previous);
    }

    return waitForEntry(start(plugin, key));
  }

  /**
   * Только принятый каталог начинает новый background, без imports UI entry.
   * Settings/locale не входят в identity и продолжают обновляться реактивно.
   */
  function acceptCatalog(catalog: readonly PluginCard[]): void {
    if (!alive()) {
      return;
    }

    const eligible = catalog.filter((plugin) => plugin.enabled && !plugin.system
      && plugin.compatibility?.status !== 'incompatible'
      && typeof plugin.runtimeGeneration === 'string' && plugin.runtimeGeneration.length > 0
      && isPluginModuleDescriptor(plugin.id, plugin.entrypoints?.web)
      && !!plugin.entrypoints?.web?.background);

    for (const [id, entry] of entries) {
      const plugin = eligible.find((item) => item.id === id);

      if (!plugin || entry.key !== JSON.stringify([plugin.runtimeGeneration, plugin.entrypoints?.web])) {
        stop(id);
      }
    }

    for (const plugin of eligible) {
      if (!entries.has(plugin.id)) {
        void ready(plugin.id).catch(() => {});
      }
    }
  }

  /**
   * Offline/logout не ожидает неизвестные await чужого start для отзыва signal.
   * Позднее завершение остаётся привязанным к своей уже остановленной записи.
   */
  function dispose(): void {
    if (disposed) {
      return;
    }

    disposed = true;

    for (const id of [...entries.keys()]) {
      stop(id);
    }

    options.signal.removeEventListener('abort', dispose);
  }

  options.signal.addEventListener('abort', dispose, { once: true });

  return {
    ready,
    acceptCatalog,
    dispose,
  };
}

export type PluginBackgroundCoordinator = ReturnType<typeof createPluginBackgroundCoordinator>;
