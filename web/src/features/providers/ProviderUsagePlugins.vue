<template>
  <template v-for="plugin in contributors" :key="plugin.id">
    <ProviderUsageResources
      v-if="snapshots[plugin.id]?.resources.length"
      :provider-id="providerId"
      :resources="resourcesOf(plugin.id)"
      readonly
    />
    <UiInlineMessage v-else-if="snapshots[plugin.id]?.error" tone="warning">
      {{ t('core.limitStatusForIsUnavailable', { value1: plugin.name }) }}
    </UiInlineMessage>
  </template>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue';

import {
  localizeProviderPluginResource,
  parseProviderPluginUsage,
} from '../../../../shared/plugins/providerUsageResources.ts';
import type { ProviderPluginResource } from '../../../../shared/plugins/providerUsageResources.ts';
import { pluginRuntimeFor } from '../../pluginRuntime/bootstrap.ts';
import { api } from '../../shared/apiClient.ts';
import { usePluginsStore } from '../../stores/plugins.ts';
import { t, UiInlineMessage, uiLocale } from '../../ui.ts';
import ProviderUsageResources from './ProviderUsageResources.vue';

const props = defineProps<{ providerId: string }>();
const plugins = usePluginsStore();
const SLOT = 'provider.popover.after-bars';
const runtime = pluginRuntimeFor();
const leases = new Map<string, Awaited<ReturnType<typeof runtime.acquireSlot>>>();
const snapshots = reactive<Record<string, { resources: ProviderPluginResource[]; error: boolean }>>({});
const available = computed(() => plugins.loaded
  && (!runtime.access || runtime.access.value.status === 'ready'));
const contributors = computed(() => available.value ? plugins.list.filter((plugin) => (
  !plugin.system && plugin.enabled && plugin.compatibility?.status !== 'incompatible'
  && plugin.contributes?.slots?.some((item) => item.slot === SLOT && item.kind === 'provider-usage')
  && plugins.placementEnabled(plugin.id, SLOT)
)).sort((left, right) => left.id.localeCompare(right.id)) : []);

let epoch = 0;
let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Отмена закрытого popup или сменившегося каталога отзывает все текущие чтения.
 * Поколение проверяется также после ответа транспорта, который не поддержал отмену.
 */
function stop() {
  epoch += 1;
  controller?.abort();

  for (const lease of leases.values()) {
    lease.release();
  }

  leases.clear();
  controller = null;
  clearTimeout(timer ?? undefined);
  timer = null;
}

/**
 * Запросы идут только в собственные API объявленных фоновых плагинов.
 * Последовательный polling живёт лишь пока смонтировано выпадающее окно исполнителя.
 */
async function refresh(owner: number, signal: AbortSignal) {
  const providerId = props.providerId;

  await Promise.all(contributors.value.map(async (plugin) => {
    try {
      let lease = leases.get(plugin.id);

      if (!lease) {
        lease = await runtime.acquireSlot(plugin.id, SLOT, { signal });
        leases.set(plugin.id, lease);
      }

      const url = `/api/ext/${encodeURIComponent(plugin.id)}/provider-usage`;
      const value = await api.get(
        `${url}?providerId=${encodeURIComponent(providerId)}`,
        {
          signal: lease.signal,
          timeoutMs: 20_000,
          retry: false,
        },
      );
      const resources = parseProviderPluginUsage(plugin.id, value);

      if (owner === epoch && !signal.aborted && !leases.get(plugin.id)?.signal.aborted) {
        snapshots[plugin.id] = { resources, error: false };
      }
    } catch {
      if (owner === epoch && !signal.aborted && !leases.get(plugin.id)?.signal.aborted) {
        snapshots[plugin.id] = { resources: snapshots[plugin.id]?.resources ?? [], error: true };
      }
    }
  }));

  if (owner === epoch && !signal.aborted) {
    timer = setTimeout(() => {
      void refresh(owner, signal);
    }, 60_000);
  }
}

/**
 * Отказ локального API не оставляет прежний прогноз визуально свежим.
 * Подпись давности принадлежит общему языку окна, тексты источника сохраняются.
 */
function resourcesOf(pluginId: string) {
  const snapshot = snapshots[pluginId];

  if (!snapshot?.error) {
    return snapshot?.resources ?? [];
  }

  return snapshot.resources.map((resource) => {
    const localized = localizeProviderPluginResource(resource, uiLocale.value);

    return {
      ...localized,
      tone: 'warn',
      translations: {},
      note: [localized.note, t('core.limitDataIsStale')].filter(Boolean).join(' · '),
    };
  });
}

watch(() => [
  runtime.access?.value?.status,
  runtime.access?.value?.owner,
  props.providerId,
  ...contributors.value.map((plugin) => JSON.stringify([
    plugin.id, plugin.version, plugin.entrypoints, plugin.install?.revision,
  ])),
],
  () => {
    stop();

    for (const id of Object.keys(snapshots)) {
      delete snapshots[id];
    }

    if (contributors.value.length) {
      controller = new AbortController();
      void refresh(epoch, controller.signal);
    }
  }, { immediate: true, flush: 'sync' });

onBeforeUnmount(stop);
</script>
