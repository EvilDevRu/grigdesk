<template>
  <PluginSlotItem
    v-for="placement in visible"
    :key="placement.pluginId"
    :placement="placement"
    :context="context"
  />
</template>

<script setup lang="ts" generic="Name extends PluginSlotName">
import { computed } from 'vue';

import type { PluginSlotContexts, PluginSlotName } from '../../../shared/plugins/slots/index.ts';
import { usePluginsStore } from '../stores/plugins.js';
import PluginSlotItem from './PluginSlotItem.vue';
import { placementsOf } from './registry.ts';

// Место в ядре, куда встают плагины. Ядро называет слот и даёт контекст, а кто в нём
// стоит — решают реестр размещений и тумблеры плагина в настройках; сам хозяин
// слота ни одного плагина не знает.
const props = defineProps<{
  name: Name;
  context: PluginSlotContexts[Name];
}>();

const plugins = usePluginsStore();

// Только включённые плагины с включённым размещением. Пока список плагинов не
// загружен, слот пуст: показать и спрятать через секунду хуже, чем показать позже.
const visible = computed(() => (
  plugins.loaded
    ? placementsOf(props.name).filter((placement) => (
      plugins.enabled(placement.pluginId) && plugins.placementEnabled(placement.pluginId, props.name)
    ))
    : []
));
</script>
