<template>
  <UiDialog v-model:open="open" :label="t('core.computerResources')" size="workspace"
            data-role="system-resources" data-ui-workspace :body-inset="false" fade-only
            initial-focus=".computer-resources">
    <template #header>
      <h2 class="ui-dialog__title">{{ t('core.computerResources') }}</h2>
      <UiIconButton :label="t('core.close')" data-context="workspace-toolbar" variant="ghost"
                    @click="open = false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </UiIconButton>
    </template>
    <ComputerResourcesPanel v-if="metrics" :metrics="metrics" :stale="stale" :snapshot-time="snapshotTime" />
    <div v-else class="computer-resources-loading">
      <UiLoadingState :label="t('core.loading')" variant="rows" />
    </div>
  </UiDialog>
</template>

<script setup lang="ts">
import type { SystemMetrics } from '../../../../shared/runtime/systemMetrics.ts';
import { t, UiDialog, UiIconButton, UiLoadingState } from '../../ui.ts';
import ComputerResourcesPanel from './ComputerResourcesPanel.vue';

defineProps<{
  metrics: SystemMetrics | null;
  stale: boolean;
  snapshotTime: string;
}>();

const open = defineModel<boolean>('open', { default: false });
</script>
