<template>
  <div class="panel" :class="{ compact }">
    <UiLoadingState style="height: 100%" :label="label" :failed="failed">
      <div class="outline">
        <UiPaneHeader class="header" :data-ui-host-actions="compact ? '' : undefined">
          <template #title><UiSkeleton width="96px" height="12px" /></template>
          <template #actions>
            <UiSkeleton shape="block" width="80px" height="var(--pane-header-action-h)" />
            <UiSkeleton shape="block" width="140px" height="var(--pane-header-action-h)" />
          </template>
        </UiPaneHeader>
        <div class="console"><UiSkeletonLayout layout="text" :header="false" :rows="12" /></div>
      </div>
    </UiLoadingState>
  </div>
</template>

<script setup lang="ts">
import { UiLoadingState, UiPaneHeader, UiSkeleton, UiSkeletonLayout } from '../../ui';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  compact?: boolean;
  label?: string;
  description?: string;
  failed?: boolean;
}>(), {
  compact: false,
  label: undefined,
  description: undefined,
  failed: false,
});
</script>

<style scoped>
.panel, .outline { height: 100%; min-height: 0; }
.outline { display: flex; flex-direction: column; }
.console { flex: 1; min-height: 0; padding: 8px 10px; overflow: hidden; }
</style>
