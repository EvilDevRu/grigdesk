<template>
  <PluginInstallDialog v-if="dialog" :open="true" mode="install" :plugin="null" package-kind="db-engine" />
  <PluginSourcePanel v-else :plugin="plugin" package-kind="db-engine" @update="emit('update')" />
  <UiDialogHost />
</template>

<script setup lang="ts">
import PluginSourcePanel from '../../../web/src/views/settings/PluginSourcePanel.vue';
import PluginInstallDialog from '../../../web/src/views/settings/PluginInstallDialog.vue';
import { UiDialogHost, setUiLocale } from '../../../web/src/ui';
import type { PluginListItem } from '../../../shared/plugins/pluginsContracts.ts';

defineProps<{ plugin: PluginListItem; dialog?: boolean }>();

const emit = defineEmits<{ update: [] }>();

defineExpose({ setUiLocale });
</script>
