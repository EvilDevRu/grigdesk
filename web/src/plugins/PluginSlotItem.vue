<template>
  <UiInlineMessage
    v-if="failure"
    tone="warning"
    v-tooltip="failure"
    data-context="plugin-slot-failure"
  >
    Плагин «{{ placement.pluginId }}» не отрисовался
  </UiInlineMessage>
  <component :is="placement.component" v-else v-bind="context" />
</template>

<script setup lang="ts">
import { onErrorCaptured, ref, watch } from 'vue';

import { UiInlineMessage, vTooltip } from '../ui';
import type { PluginPlacement } from './registry.ts';

// Одно размещение в своей границе ошибок: упавший компонент плагина показывает
// короткое сообщение на своём месте, а хозяин слота и соседи по нему живут дальше.
const props = defineProps<{
  placement: PluginPlacement;
  context: Record<string, unknown>;
}>();

const failure = ref('');

onErrorCaptured((error) => {
  failure.value = error instanceof Error && error.message ? error.message : 'ошибка плагина';

  return false;
});

// Смена компонента (другая регистрация того же плагина) даёт ему новую попытку.
watch(() => props.placement.component, () => {
  failure.value = '';
});
</script>
