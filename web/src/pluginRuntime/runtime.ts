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
  start: unknown;
};
type PanelOwner = { active: boolean; release: Cleanup };

interface RuntimeEntry {
  descriptor: string;
  controller: AbortController;
  panelActive: Ref<boolean>;
  backgroundActive: Ref<boolean>;
  panels: Set<PanelOwner>;
  background: boolean;
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

        const services = createPluginContextServices(base, {
          ...options,
          signal: controller.signal,
          panelActive: entry.panelActive,
          backgroundActive: entry.backgroundActive,
          isAlive,
        });

        entry.clearPanel = services.clearPanel;

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
      background: false,
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

          if (!entry.background && entries.get(pluginId) === entry) {
            stop(pluginId);
          }
        }
      },
    };

    entry.panels.add(owner);
    updateActive();
    init.signal?.addEventListener('abort', owner.release, { once: true });

    try {
      const prepared = await entry.pending;

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
   * Только явный opt-in допускает named hook, загрузчик сам его не исполняет.
   * Фоновые подписки разрешены уже внутри start, в том числе до его первого await.
   */
  async function startBackground(pluginId: string, descriptor: PluginWebModule): Promise<Prepared> {
    const entry = entryFor(pluginId, descriptor);

    if (descriptor.startOnLogin !== true) {
      return entry.pending;
    }

    entry.background = true;
    entry.starting ??= (async () => {
      try {
        const prepared = await entry.pending;

        entry.controller.signal.throwIfAborted();

        if (typeof prepared.start !== 'function') {
          throw new PluginModuleError('load-failed');
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

  const reset = () => {
    for (const id of [...entries.keys()]) {
      stop(id);
    }

    failures.clear();
  };

  return {
    access: options.access,
    acquirePanel,
    startBackground,
    stop,
    reset,
    dispose: () => {
      disposed = true;
      reset();
    },
  };
}

export type PluginRuntime = ReturnType<typeof createPluginRuntime>;
