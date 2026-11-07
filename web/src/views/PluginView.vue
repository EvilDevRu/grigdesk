<template>
  <div class="tool-route-adapter" :data-tool-route="`ext:${$route.params.id}`" aria-hidden="true"></div>
</template>

<script setup lang="ts">
import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePluginsStore } from '../stores/plugins.ts';
import { useDockStore } from '../stores/dock.ts';
import { decodePluginPanelParams } from '../../../shared/plugins/pluginPanelParams.ts';
import { pluginRuntimeAccessFor } from '../pluginRuntime/bootstrap.ts';
import { resolvePluginRouteState } from '../shared/tools/pluginRouteState.ts';

// Маршрут объявляет цель, а постоянный ToolHost владеет единственной панелью.
// Узкое окно и док используют один экземпляр модуля.
const route = useRoute();
const router = useRouter();
const plugins = usePluginsStore();
const dock = useDockStore();
const access = pluginRuntimeAccessFor();
let accepted = '';

/**
 * Query сохраняется до появления доступной панели и принятия общей очередью.
 * Обновление каталога не повторяет уже переданное намерение во время replace.
 */
function acceptQuery(): void {
  const id = typeof route.params.id === 'string' ? route.params.id : '';
  const params = decodePluginPanelParams(route.query);

  if (!Object.keys(route.query).length) {
    accepted = '';

    return;
  }

  const state = resolvePluginRouteState(id, {
    list: plugins.list,
    loaded: plugins.loaded,
    loadError: plugins.loadError,
    accepted: access?.value.status === 'ready',
  });

  if (!params || state.status !== 'ready') {
    return;
  }

  const key = JSON.stringify([id, params]);

  if (key === accepted) {
    return;
  }

  dock.enqueue(id, { type: 'open', params });
  accepted = key;
  void router.replace({
    path: route.path,
    query: {},
    hash: route.hash,
  });
}

watch(() => [
  route.params.id,
  route.query,
  plugins.list,
  plugins.loaded,
  plugins.loadError,
  access?.value.status,
], acceptQuery, { immediate: true, deep: true });
</script>
