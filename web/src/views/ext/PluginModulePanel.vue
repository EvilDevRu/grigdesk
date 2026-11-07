<template>
  <section
    :data-perf-pending="state === 'loading' ? '' : undefined"
    :data-perf-error="state !== 'loading' && state !== 'ready' ? '' : undefined"
    class="plugin-module" :class="{ 'is-compact': compact }" :aria-label="label">
    <component
      :is="component"
      v-if="state === 'ready' && component && context"
      :context="context"
      :active="active"
      :compact="compact"
      :presentation="presentation"
      :intents="panelIntents"
      @consume-intent="emit('consume-intent', $event)"
    />
    <PluginPanelLoading v-else-if="state === 'loading'" :label="message" />
    <UiInlineMessage v-else tone="warning">
      {{ message }}
    </UiInlineMessage>
  </section>
</template>

<script setup lang="ts">
import PluginPanelLoading from './PluginPanelLoading.vue';

import { computed, onBeforeUnmount, onErrorCaptured, shallowRef, ref, watch } from 'vue';
import type { Component } from 'vue';
import type { PluginWebModule } from '../../../../shared/plugins/pluginsContracts.ts';
import { UiInlineMessage, t } from '../../ui.ts';
import { pluginRuntimeFor } from '../../pluginRuntime/bootstrap.ts';
import { loadPluginStyles } from '../../pluginRuntime/styles.ts';
import type { PluginModuleContext } from '../../pluginRuntime/contextServices.ts';
import type { PluginPresentation } from '../../../../packages/plugin-types/src/web.js';
import type { PluginRuntime } from '../../pluginRuntime/runtime.ts';
import { decodePluginPanelParams } from '../../../../shared/plugins/pluginPanelParams.ts';
import type { PluginPanelIntent } from '../../../../packages/plugin-types/src/web.js';

const props = withDefaults(defineProps<{
  pluginId: string;
  descriptor: PluginWebModule;
  label: string;
  active?: boolean;
  compact?: boolean;
  presentation?: PluginPresentation;
  intents?: readonly Record<string, unknown>[];
}>(), { active: true });

const emit = defineEmits<{ 'consume-intent': [id: number] }>();
const panelIntents = computed<PluginPanelIntent[]>(() => (props.intents ?? []).flatMap((intent) => {
  const params = decodePluginPanelParams(intent.params);

  return Number.isSafeInteger(intent.id) && typeof intent.type === 'string' && params
    ? [{
      id: intent.id as number,
      type: intent.type,
      params,
    }] : [];
}));

type PanelState = 'loading' | 'ready' | 'unsupported' | 'load-failed' | 'render-failed';

type PanelLease = Awaited<ReturnType<PluginRuntime['acquirePanel']>>;

const runtime = pluginRuntimeFor();
const state = ref<PanelState>('loading');
const component = shallowRef<Component | null>(null);
const context = shallowRef<PluginModuleContext | null>(null);
let generation = 0;
let controller: AbortController | null = null;
let releaseStyles: (() => void) | null = null;
let lease: PanelLease | null = null;
let removeRuntimeAbort: (() => void) | null = null;
let suspended = false;
let panelKey = '';
let panelOwner: string | null | undefined;

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
 * Отмена подготовки и lease не обязана удалять уже показанный компонент.
 * При обрыве оболочки его DOM и готовый CSS остаются до восстановления того же владельца.
 */
function releaseLease(): void {
  generation += 1;
  removeRuntimeAbort?.();
  removeRuntimeAbort = null;
  controller?.abort();
  controller = null;
  lease?.release();
  lease = null;
}

/**
 * Смена владельца, ресурсов и размонтирование освобождают всю панель.
 * Удаление компонента перед освобождением CSS сохраняет границу панели.
 */
function dispose(): void {
  component.value = null;
  context.value = null;
  suspended = false;
  releaseLease();
  releaseStyles?.();
  releaseStyles = null;
}

/**
 * Поздний import не должен вернуть предыдущую панель после смены id.
 * Ресурсы сохраняются до подготовки контекста и освобождаются при любом отказе.
 */
async function prepare(preserve = false): Promise<void> {
  if (preserve) {
    releaseLease();
  } else {
    dispose();
    state.value = 'loading';
  }

  suspended = false;
  panelKey = JSON.stringify([props.pluginId, props.descriptor]);
  panelOwner = runtime.access?.value.owner;

  const current = generation;
  const attempt = new AbortController();
  const timer = setTimeout(() => attempt.abort(), 30_000);

  controller = attempt;

  try {
    const loaded = await runtime.acquirePanel(props.pluginId, props.descriptor, {
      signal: attempt.signal,
      active: props.active !== false,
    });

    if (generation !== current) {
      loaded.release();

      return;
    }

    lease = loaded;
    lease.setActive(props.active !== false);

    const revoked = () => {
      dispose();
      state.value = 'load-failed';
    };

    loaded.context.signal?.addEventListener('abort', revoked, { once: true });
    removeRuntimeAbort = () => loaded.context.signal?.removeEventListener('abort', revoked);
    loaded.context.signal?.throwIfAborted();

    const styles = releaseStyles ?? await loadPluginStyles(props.descriptor.css, attempt.signal);

    if (generation !== current) {
      styles();

      return;
    }

    releaseStyles = styles;
    context.value = loaded.context;
    component.value = loaded.component;
    state.value = 'ready';
    controller = null;
  } catch (error) {
    if (generation !== current) {
      return;
    }

    dispose();
    state.value = error && typeof error === 'object' && 'code' in error && error.code === 'unsupported'
      ? 'unsupported' : 'load-failed';
  } finally {
    clearTimeout(timer);
  }
}

onErrorCaptured(() => {
  dispose();
  state.value = 'render-failed';

  return false;
});

/**
 * Только временная потеря связи того же владельца сохраняет смонтированный UI.
 * Свежий каталог возвращает панели общий с фоном context без повторного setup.
 */
function syncPanel(): void {
  const access = runtime.access?.value;
  const samePanel = panelKey === JSON.stringify([props.pluginId, props.descriptor])
    && panelOwner === access?.owner;

  if (access && access.status !== 'ready') {
    if (samePanel && (access.status === 'suspended' || suspended && access.status === 'waiting')) {
      suspended = true;
      releaseLease();
    } else {
      dispose();
      state.value = 'loading';
    }

    return;
  }

  void prepare(suspended && samePanel);
}

watch(() => JSON.stringify([props.pluginId, props.descriptor]), syncPanel, { immediate: true });
watch(() => JSON.stringify(runtime.access?.value), syncPanel, { flush: 'sync' });
watch(() => props.active, (active) => lease?.setActive(active !== false), { flush: 'sync' });
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
