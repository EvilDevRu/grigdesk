import {
  computed,
  getCurrentScope,
  onScopeDispose,
  readonly,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue';
import type { UiLayerCloseHandler, UiLayerName } from '../types/uiLayers';
import type { UiLayerHandle } from '../types/uiLayers';
import { normalizeUiLayerName, uiLayerProps, uiLayerPriority } from '../services/layers/priorities';
import {
  refreshLayerStack,
  registerUiLayer,
  subscribeLayerStack,
} from '../services/layers/stack';

export interface UseUiLayerOptions {
  id?: string;
  enabled?: MaybeRefOrGetter<boolean>;
  onEscape?: UiLayerCloseHandler;
  element?: MaybeRefOrGetter<HTMLElement | null>;
}

let layerInstanceSequence = 0;

/**
 * Public lifecycle-обёртка над private stack. Ни consumer, ни SFC не знают z-index.
 */
export function useUiLayer(
  requestedName: MaybeRefOrGetter<UiLayerName>,
  options: UseUiLayerOptions = {},
) {
  const instanceId = options.id ?? `ui-layer-${++layerInstanceSequence}`;
  const name = computed(() => normalizeUiLayerName(toValue(requestedName)));
  const enabled = computed(() => options.enabled === undefined || Boolean(toValue(options.enabled)));
  const isTop = ref(false);
  let handle: UiLayerHandle | null = null;

  const syncTop = () => {
    isTop.value = Boolean(handle?.isTop());
  };
  const unsubscribe = subscribeLayerStack(syncTop);

  function unregister(): void {
    handle?.unregister();
    handle = null;
    syncTop();
  }

  function register(): void {
    unregister();
    if (!enabled.value) return;
    handle = registerUiLayer(instanceId, {
      name: name.value,
      close: (event) => options.onEscape ? options.onEscape(event) : false,
      enabled: () => enabled.value,
      element: options.element === undefined
        ? undefined
        : () => toValue(options.element) ?? null,
    });
    syncTop();
  }

  watch([name, enabled], register, { immediate: true, flush: 'sync' });
  if (options.element !== undefined) {
    watch(() => toValue(options.element), refreshLayerStack, { flush: 'post' });
  }

  const priority = computed(() => uiLayerPriority(name.value));
  const layerProps = computed(() => uiLayerProps(name.value));

  function dispose(): void {
    unregister();
    unsubscribe();
  }
  if (getCurrentScope()) onScopeDispose(dispose);

  return {
    name,
    priority,
    isTopLayer: readonly(isTop),
    layerProps,
    register,
    unregister,
    refresh: refreshLayerStack,
  };
}
