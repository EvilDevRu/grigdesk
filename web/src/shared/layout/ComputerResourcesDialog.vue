<template>
  <UiDialog v-model:open="open" :title="t('core.computerResources')" size="workspace"
            data-role="system-resources" data-ui-workspace :body-inset="false" fade-only
            initial-focus=".computer-resources"
            :close-label="t('core.close')">
    <ComputerResourcesPanel v-if="metrics" :metrics="metrics" :stale="stale" :snapshot-time="snapshotTime" />
    <div v-else class="computer-resources-loading">
      <UiLoadingState :label="t('core.loading')" variant="rows" />
    </div>
  </UiDialog>
</template>

<script setup lang="ts">
import type { SystemMetrics } from '../../../../shared/runtime/systemMetrics.ts';
import { t, UiDialog, UiLoadingState } from '../../ui.ts';
import ComputerResourcesPanel from './ComputerResourcesPanel.vue';

defineProps<{
  metrics: SystemMetrics | null;
  stale: boolean;
  snapshotTime: string;
}>();

const open = defineModel<boolean>('open', { default: false });
</script>
