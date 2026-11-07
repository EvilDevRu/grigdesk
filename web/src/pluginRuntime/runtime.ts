import type { PluginModuleStart } from '../../../packages/plugin-types/src/web.js';
import { ref } from 'vue';
import type { Component, Ref } from 'vue';
import type { PluginWebModule, PluginListItem } from '../../../shared/plugins/pluginsContracts.ts';
import { loadPluginModule, PluginModuleError } from './loader.ts';
import { createPluginContext } from './context.ts';
import { createPluginContextServices } from './contextServices.ts';
import type { PluginModuleContext, PluginServiceOptions } from './contextServices.ts';

type PluginCard = Pick<PluginListItem, 'enabled'> & Partial<PluginListItem>;
type Cleanup = () => void;
type Prepared = {
  component: Component;
  context: PluginModuleContext;
  start: PluginModuleStart | undefined;
};
type PanelOwner = { active: boolean; release: Cleanup };

interface RuntimeEntry {
  descriptor: string;
  controller: AbortController;
  panelActive: Ref<boolean>;
  backgroundActive: Ref<boolean>;
  panels: Set<PanelOwner>;
  slots: Set<Cleanup>;
  pending: Promise<Prepared>;
  starting?: Promise<Prepared>;
  cleanup?: Cleanup;
  releaseModule?: Cleanup;
  clearPanel?: Cleanup;
}

export interface PluginRuntimeAccess {
  owner: string | null;
  status: 'waiting' | 'ready' | 'suspended' | 'revoked';
}

export interface PluginRuntimeOptions {
  plugins: { byId(id: string): PluginCard | null };
  router: PluginServiceOptions['router'];
  dock: PluginServiceOptions['dock'];
  chat?: PluginServiceOptions['chat'];
  isAvailable?: () => boolean;
  waitForAccess?: () => Promise<void>;
  access?: Readonly<Ref<PluginRuntimeAccess>>;
  loadPluginModule?: typeof loadPluginModule;
  createPluginContext?: typeof createPluginContext;
  backgroundReady?: (pluginId: string) => Promise<void>;
}

/**
 * Очистка доверенного hook не должна мешать отзыву остальных ресурсов.
 * Вызывающий забирает функцию из записи перед вызовом, гарантируя однократность.
 */
function safely(cleanup?: Cleanup): void {
  try {
    cleanup?.();
  } catch {
    // Ошибка одного плагина не прерывает остановку остальных экземпляров.
  }
}

/**
 * Реестр окна разделяет одну загрузку и один контекст между фоном и всеми панелями.
 * Остановленная запись никогда не переиспользуется: новый допуск создаёт новый signal.
 */
export function createPluginRuntime(options: PluginRuntimeOptions) {
  const entries = new Map<string, RuntimeEntry>();
  const serverSlots = new Map<string, Set<Cleanup>>();
  const failures = new Map<string, { descriptor: string; error: unknown }>();
  const load = options.loadPluginModule ?? loadPluginModule;
  const createContext = options.createPluginContext ?? createPluginContext;
  let disposed = false;

  /**
   * Сначала отзываем права и подписки, затем исполняем пользовательский cleanup.
   * Поздний start сам освободит свой результат, не задерживая синхронную остановку.
   */
  function stop(pluginId: string): void {
    const entry = entries.get(pluginId);

    failures.delete(pluginId);

    const leases = serverSlots.get(pluginId);

    serverSlots.delete(pluginId);

    for (const release of leases ?? []) {
      release();
    }


    if (!entry) {
      return;
    }

    entries.delete(pluginId);
    entry.controller.abort();
    entry.backgroundActive.value = false;
    entry.panelActive.value = false;

    const cleanup = entry.cleanup;

    entry.cleanup = undefined;
    safely(cleanup);
    safely(entry.releaseModule);
    entry.releaseModule = undefined;
    entry.clearPanel?.();
  }

  /**
   * Новый дескриптор отзывает прежний экземпляр до любого импорта.
   * Настройки читаются через замкнутый допуск, поэтому старый ref не увидит нового владельца.
   */
  function entryFor(pluginId: string, descriptor: PluginWebModule): RuntimeEntry {
    const key = JSON.stringify(descriptor);
    const previous = entries.get(pluginId);
    const failure = failures.get(pluginId);

    if (failure?.descriptor === key) {
      throw failure.error;
    }

    if (previous?.descriptor === key) {
      return previous;
    }

    stop(pluginId);

    const controller = new AbortController();
    let entry: RuntimeEntry;
    const isAlive = () => !disposed && !controller.signal.aborted
      && (options.isAvailable?.() ?? true)
      && options.plugins.byId(pluginId)?.enabled === true
      && !options.plugins.byId(pluginId)?.system;

    const pending = Promise.resolve().then(async () => {
      try {
        if (!isAlive()) {
          throw new PluginModuleError('load-failed');
        }

        const loaded = await load(pluginId, descriptor, { signal: controller.signal, styles: false });

        if (!isAlive()) {
          safely(loaded.releaseStyles);
          controller.signal.throwIfAborted();

          throw new PluginModuleError('load-failed');
        }

        entry.releaseModule = loaded.releaseStyles;

        const base = await createContext(pluginId, descriptor, {
          byId: (id) => isAlive() ? options.plugins.byId(id) : null,
        }, { signal: controller.signal });

        controller.signal.throwIfAborted();

        const owner = options.access?.value.owner;
        const generation = options.plugins.byId(pluginId)?.runtimeGeneration;
        const services = createPluginContextServices(base, {
          ...options,
          signal: controller.signal,
          panelActive: entry.panelActive,
          backgroundActive: entry.backgroundActive,
          isAlive,
          ...(typeof owner === 'string' && typeof generation === 'string' && generation.length > 0 ? {
            notificationIdentity: { owner, generation },
          } : {}),
        });

        entry.clearPanel = services.clearPanel;

        if (descriptor.background && options.backgroundReady) {
          services.context.backgroundReady = async () => {
            controller.signal.throwIfAborted();

            if (!isAlive()) {
              throw new PluginModuleError('load-failed');
            }

            await options.backgroundReady!(pluginId);
            controller.signal.throwIfAborted();
          };
        }

        return {
          component: loaded.component,
          context: services.context,
          start: loaded.start,
        };
      } catch (error) {
        if (entries.get(pluginId) === entry) {
          stop(pluginId);
        }

        throw error;
      }
    });

    entry = {
      descriptor: key,
      controller,
      panelActive: ref(false),
      backgroundActive: ref(false),
      panels: new Set(),
      slots: new Set(),
      pending,
    };
    entries.set(pluginId, entry);

    return entry;
  }

  /**
   * Lease создаётся до ожидания загрузки и снимается даже при позднем результате.
   * Скрытие сохраняет регистрации и DOM, последний unmount удаляет панельные регистрации.
   */
  async function acquirePanel(pluginId: string, descriptor: PluginWebModule,
    init: { active?: boolean; signal?: AbortSignal } = {}) {
    await options.waitForAccess?.();
    init.signal?.throwIfAborted();

    const plugin = options.plugins.byId(pluginId);

    if (!plugin?.enabled || plugin.compatibility?.status === 'incompatible'
      || !plugin.contributes?.panels?.length) {
      throw new PluginModuleError('load-failed');
    }

    const entry = entryFor(pluginId, descriptor);
    let released = false;
    const updateActive = () => {
      entry.panelActive.value = [...entry.panels].some((owner) => owner.active);
    };
    const owner: PanelOwner = {
      active: init.active !== false,
      release: () => {
        if (released) {
          return;
        }

        released = true;
        init.signal?.removeEventListener('abort', owner.release);
        entry.panels.delete(owner);
        updateActive();

        if (entry.panels.size === 0) {
          entry.clearPanel?.();

          if (entry.slots.size === 0 && entries.get(pluginId) === entry) {
            stop(pluginId);
          }
        }
      },
    };

    entry.panels.add(owner);
    updateActive();
    init.signal?.addEventListener('abort', owner.release, { once: true });

    try {
      const prepared = await startEntry(pluginId, entry);

      entry.controller.signal.throwIfAborted();
      init.signal?.throwIfAborted();

      return {
        component: prepared.component,
        context: prepared.context,
        release: owner.release,
        setActive: (active: boolean) => {
          if (!released) {
            owner.active = active;
            updateActive();
          }
        },
      };
    } catch (error) {
      owner.release();

      throw error;
    }
  }

  /**
   * Первый спрос запускает необязательный hook ровно один раз на общий контекст.
   * Поздний результат после отмены освобождается самим завершившимся hook.
   */
  async function startEntry(pluginId: string, entry: RuntimeEntry): Promise<Prepared> {
    entry.starting ??= (async () => {
      try {
        const prepared = await entry.pending;

        entry.controller.signal.throwIfAborted();

        if (typeof prepared.start !== 'function') {
          return prepared;
        }

        entry.backgroundActive.value = true;

        const cleanup: unknown = await prepared.start(prepared.context);

        if (entry.controller.signal.aborted) {
          safely(typeof cleanup === 'function' ? cleanup as Cleanup : undefined);
          entry.controller.signal.throwIfAborted();
        }

        entry.cleanup = typeof cleanup === 'function' ? cleanup as Cleanup : undefined;

        return prepared;
      } catch (error) {
        if (entries.get(pluginId) === entry) {
          stop(pluginId);
          failures.set(pluginId, { descriptor: entry.descriptor, error });
        }

        throw error;
      }
    })();

    return entry.starting;
  }

  /**
   * Слот получает отдельного владельца того же модуля, что и открытая панель.
   * Серверный поставщик без ESM использует только отзываемый signal запроса.
   */
  async function acquireSlot(pluginId: string, slot: string, init: { signal?: AbortSignal } = {}) {
    await options.waitForAccess?.();
    init.signal?.throwIfAborted();

    const plugin = options.plugins.byId(pluginId);

    if (!plugin?.enabled || plugin.system || plugin.compatibility?.status === 'incompatible'
      || !plugin.contributes?.slots?.some((item) => item.slot === slot && item.kind === 'provider-usage')
      || !plugin.placements?.some((item) => item.slot === slot && item.enabled)) {
      throw new PluginModuleError('load-failed');
    }

    const descriptor = plugin.entrypoints?.web;
    const entry = descriptor ? entryFor(pluginId, descriptor) : null;
    const controller = new AbortController();
    /**
     * Отзыв слота завершает его запрос и освобождает только собственного владельца.
     * Панель сохраняет общий экземпляр до освобождения последнего места.
     */
    const release = () => {
      controller.abort();
      init.signal?.removeEventListener('abort', release);
      entry?.controller.signal.removeEventListener('abort', release);
      entry?.slots.delete(release);
      serverSlots.get(pluginId)?.delete(release);

      if (entry && !entry.slots.size && !entry.panels.size && entries.get(pluginId) === entry) {
        stop(pluginId);
      }
    };

    if (entry) {
      entry.slots.add(release);
    } else {
      const owners = serverSlots.get(pluginId) ?? new Set<Cleanup>();

      owners.add(release);
      serverSlots.set(pluginId, owners);
    }

    init.signal?.addEventListener('abort', release, { once: true });
    entry?.controller.signal.addEventListener('abort', release, { once: true });

    try {
      if (entry) {
        await startEntry(pluginId, entry);
      }

      controller.signal.throwIfAborted();

      return { signal: controller.signal, release };
    } catch (error) {
      release();

      throw error;
    }
  }

  const reset = () => {
    for (const id of new Set([...entries.keys(), ...serverSlots.keys()])) {
      stop(id);
    }

    failures.clear();
  };

  return {
    access: options.access,
    acquirePanel,
    acquireSlot,
    stop,
    reset,
    dispose: () => {
      disposed = true;
      reset();
    },
  };
}

export type PluginRuntime = ReturnType<typeof createPluginRuntime>;
