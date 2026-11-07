<template>
  <PluginSourcePanel :plugin="plugin" @bind="emit('bind')" @update="emit('update')" />
  <UiDialogHost />
</template>

<script setup lang="ts">
import PluginSourcePanel from '../../../web/src/views/settings/PluginSourcePanel.vue';
import { UiDialogHost } from '../../../web/src/ui';
import type { PluginListItem } from '../../../shared/plugins/pluginsContracts.ts';

defineProps<{ plugin: PluginListItem }>();

const emit = defineEmits<{
  update: [];
  bind: [];
}>();
</script>
