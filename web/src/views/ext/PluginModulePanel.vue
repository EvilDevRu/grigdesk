<template>
  <section class="plugin-module" :class="{ 'is-compact': compact }" :aria-label="label">
    <component
      :is="component"
      v-if="state === 'ready' && component && context"
      :context="context"
      :active="active"
      :compact="compact"
      :presentation="presentation"
    />
    <UiLoadingState v-else-if="state === 'loading'" :label="message" />
    <UiInlineMessage v-else tone="warning">
      {{ message }}
    </UiInlineMessage>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onErrorCaptured, shallowRef, ref, watch } from 'vue';
import type { Component } from 'vue';
import type { PluginWebModule } from '../../../../shared/plugins/pluginsContracts.ts';
import {
  UiInlineMessage,
  t,
  UiLoadingState,
} from '../../ui.ts';
import { usePluginsStore } from '../../stores/plugins.ts';
import { loadPluginModule } from '../../pluginRuntime/loader.ts';
import { createPluginContext } from '../../pluginRuntime/context.ts';
import type { PluginContext } from '../../pluginRuntime/context.ts';

const props = defineProps<{
  pluginId: string;
  descriptor: PluginWebModule;
  label: string;
  active?: boolean;
  compact?: boolean;
  presentation?: string;
}>();

type PanelState = 'loading' | 'ready' | 'unsupported' | 'load-failed' | 'render-failed';

const plugins = usePluginsStore();
const state = ref<PanelState>('loading');
const component = shallowRef<Component | null>(null);
const context = shallowRef<PluginContext | null>(null);
let generation = 0;
let controller: AbortController | null = null;
let releaseStyles: (() => void) | null = null;

const message = computed(() => {
  const params = { name: props.label };

  switch (state.value) {
    case 'unsupported': return t('core.pluginModuleUnsupported', params);
    case 'load-failed': return t('core.pluginModuleLoadFailed', params);
    case 'render-failed': return t('core.pluginModuleRenderFailed', params);
    default: return t('core.pluginModuleLoading', params);
  }
});

/**
 * Смена ресурсов и размонтирование отменяют только текущую попытку.
 * Удаление компонента перед освобождением CSS сохраняет границу панели.
 */
function dispose(): void {
  generation += 1;
  controller?.abort();
  controller = null;
  component.value = null;
  context.value = null;
  releaseStyles?.();
  releaseStyles = null;
}

/**
 * Поздний import не должен вернуть предыдущую панель после смены id.
 * Ресурсы сохраняются до подготовки контекста и освобождаются при любом отказе.
 */
async function prepare(): Promise<void> {
  dispose();
  state.value = 'loading';

  const current = generation;
  const attempt = new AbortController();

  controller = attempt;

  try {
    const loaded = await loadPluginModule(props.pluginId, props.descriptor, { signal: attempt.signal });

    if (generation !== current) {
      loaded.releaseStyles();

      return;
    }

    releaseStyles = loaded.releaseStyles;

    const prepared = await createPluginContext(props.pluginId, props.descriptor, plugins, {
      signal: attempt.signal,
    });

    if (generation !== current) {
      return;
    }

    context.value = prepared;
    component.value = loaded.component;
    state.value = 'ready';
  } catch (error) {
    if (generation !== current) {
      return;
    }

    dispose();
    state.value = error && typeof error === 'object' && 'code' in error && error.code === 'unsupported'
      ? 'unsupported' : 'load-failed';
  }
}

onErrorCaptured(() => {
  dispose();
  state.value = 'render-failed';

  return false;
});

watch(() => JSON.stringify([props.pluginId, props.descriptor]), () => void prepare(), { immediate: true });
onBeforeUnmount(dispose);
</script>

<style scoped>
.plugin-module {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: auto;
}

.plugin-module.is-compact {
  padding-top: 36px;
}
</style>
