import { getCurrentInstance, getCurrentScope, onScopeDispose, watch } from 'vue';
import type { Ref } from 'vue';
import { isRecord } from '../../../shared/lib/objects.ts';
import { sseSubscribe } from '../composables/useSse.ts';

import type { PluginEventOptions } from '../../../packages/plugin-types/src/web.js';

export type { PluginEventOptions } from '../../../packages/plugin-types/src/web.js';

type Subscribe = (event: string, listener: (data: unknown) => void, init: PluginEventOptions) => () => void;

const panelSubscriptions = new WeakMap<Subscribe, Subscribe>();

type ProviderSubscribe = (listener: () => void) => () => void;

const providerSubscriptions = new WeakMap<ProviderSubscribe, ProviderSubscribe>();

/**
 * Доставка использует общую шину окна и замыкает идентификатор плагина.
 * Скрытие снимает транспортную подписку, сохраняя регистрацию до следующего показа.
 */
export function createPluginEvents(pluginId: string, options: {
  signal: AbortSignal;
  panelActive: Readonly<Ref<boolean>>;
  backgroundActive: Readonly<Ref<boolean>>;
}) {
  const panelRegistrations = new Set<() => void>();

  /**
   * У каждой регистрации свой срок и идемпотентное снятие.
   * Ошибка доверенного обработчика не прерывает доставку другим подписчикам.
   */
  function subscribe(
    event: string,
    listener: (data: unknown) => void,
    init: PluginEventOptions,
    providers = false,
  ) {
    const background = init.lifetime === 'background';
    const active = background ? options.backgroundActive : options.panelActive;

    if (options.signal.aborted || background && !active.value
      || typeof event !== 'string' || !event || typeof listener !== 'function') {
      return () => {};
    }

    let unsubscribe: (() => void) | null = null;
    let disposed = false;
    let stopWatch = () => {};

    /**
     * Ручное снятие, unmount и abort сходятся в одну идемпотентную очистку.
     * После неё watcher уже не может восстановить транспортную подписку.
     */
    const off = () => {
      if (disposed) {
        return;
      }

      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      stopWatch();
      panelRegistrations.delete(off);
      options.signal.removeEventListener('abort', off);
    };

    stopWatch = watch(active, (enabled) => {
      unsubscribe?.();
      unsubscribe = null;

      if (!enabled || disposed || options.signal.aborted) {
        return;
      }

      unsubscribe = sseSubscribe((name, envelope) => {
        if (providers) {
          if (name === 'providers-update') {
            try {
              listener(undefined);
            } catch {
              // Ошибка подписчика не прерывает общий транспорт исполнителей.
            }
          }

          return;
        }

        if (name !== 'plugin-event' || !isRecord(envelope)
          || envelope.pluginId !== pluginId || envelope.event !== event) {
          return;
        }

        try {
          listener(envelope.data);
        } catch {
          // Чужой callback не владеет общей шиной и её остальными подписчиками.
        }
      });
    }, { immediate: true, flush: 'sync' });

    if (!background) {
      panelRegistrations.add(off);
    }

    options.signal.addEventListener('abort', off, { once: true });

    if (getCurrentScope()) {
      onScopeDispose(off);
    }

    return off;
  }

  /**
   * Сохранённый компонент получает новый context после восстановления оболочки.
   * Его setup-подписка следует за prop, прежний отозванный context прав не получает.
   */
  function on(event: string, listener: (data: unknown) => void, init: PluginEventOptions = {}) {
    type PanelContext = { pluginId: string; events: { on: typeof on } };

    const props = getCurrentInstance()?.props;
    const panelContext = () => props?.context as PanelContext | undefined;

    if (init.lifetime === 'background' || !getCurrentScope() || panelContext()?.events?.on !== on) {
      return subscribe(event, listener, init);
    }

    const off = watch(panelContext, (context, previous, cleanup) => {
      if (context?.pluginId !== pluginId) {
        return;
      }

      const register = panelSubscriptions.get(context.events.on);

      if (register) {
        cleanup(register(event, listener, init));
      }
    }, { immediate: true, flush: 'sync' });

    onScopeDispose(off);

    return off;
  }

  panelSubscriptions.set(on, subscribe);

  const subscribeProvider: ProviderSubscribe = (listener) =>
    subscribe('providers-update', () => listener(), {}, true);

  /**
   * Исполнители передают только факт изменения, без сырого SSE payload.
   * Setup-регистрация следует за новым prop context так же, как события панели.
   */
  function onProvidersChanged(listener: () => void) {
    type ProviderContext = {
      pluginId: string;
      providers: { onChanged: ProviderSubscribe };
    };

    const props = getCurrentInstance()?.props;
    const panelContext = () => props?.context as ProviderContext | undefined;

    if (!getCurrentScope() || panelContext()?.providers?.onChanged !== onProvidersChanged) {
      return subscribeProvider(listener);
    }

    const off = watch(panelContext, (context, previous, cleanup) => {
      if (context?.pluginId === pluginId) {
        const register = providerSubscriptions.get(context.providers.onChanged);

        if (register) {
          cleanup(register(listener));
        }
      }
    }, { immediate: true, flush: 'sync' });

    onScopeDispose(off);

    return off;
  }

  providerSubscriptions.set(onProvidersChanged, subscribeProvider);

  return {
    on,
    onProvidersChanged,
    clearPanel: () => {
      for (const off of [...panelRegistrations]) {
        off();
      }
    },
  };
}
