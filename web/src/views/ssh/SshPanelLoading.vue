<template>
  <div class="panel" :class="{ compact, dock: presentation === 'dock' }">
    <UiLoadingState style="height: 100%" :label="label" :failed="failed">
      <div class="outline">
        <div class="heading">
          <UiPaneHeader>
            <template #title><UiSkeleton width="72px" height="18px" /></template>
            <template #meta><UiSkeleton class="summary" width="150px" height="18px" /></template>
            <template #actions><UiSkeleton width="160px" height="var(--toolbar-control-h)" /></template>
          </UiPaneHeader>
        </div>
        <div class="navigation"><UiSkeleton width="180px" height="var(--toolbar-control-h)" /></div>
        <div class="split">
          <div class="list">
            <UiPaneHeader class="list-header">
              <template #title><UiSkeleton width="90px" height="18px" /></template>
            </UiPaneHeader>
            <div class="search"><UiSkeleton shape="block" height="32px" /></div>
            <div class="rows"><UiSkeletonLayout :header="false" /></div>
          </div>
          <div class="body">
            <div class="console"><UiSkeletonLayout layout="text" :rows="10" /></div>
            <div class="audit"><UiSkeleton width="35%" height="16px" /></div>
          </div>
        </div>
      </div>
    </UiLoadingState>
  </div>
</template>

<script setup lang="ts">
import { UiLoadingState, UiPaneHeader, UiSkeleton, UiSkeletonLayout } from '../../ui';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  compact?: boolean;
  presentation?: string;
  label?: string;
  description?: string;
  failed?: boolean;
}>(), {
  compact: false,
  presentation: 'page',
  label: undefined,
  description: undefined,
  failed: false,
});
</script>

<style scoped>
.panel { container: ssh-loading / inline-size; width: 100%; overflow: hidden; }
.panel, .outline { height: 100%; min-height: 0; min-width: 0; }
.outline { display: flex; flex-direction: column; overflow: hidden; }
.heading { flex: none; }
.navigation { display: none; flex: none; padding: 6px 12px; border-bottom: 1px solid var(--line); }
.split {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  min-height: 0;
}
.list { min-width: 0; overflow: hidden; border-right: 1px solid var(--line); background: var(--sidebar); }
.search { padding: 10px 10px 0; }
.rows { padding: 8px 10px 10px; }
.body { display: flex; flex-direction: column; gap: 12px;
  grid-column: 2; grid-row: 1; min-height: 0; min-width: 0; padding: 12px; }
.console { flex: 1; min-height: 300px; padding: 16px; border: 1px solid var(--line); }
.audit { display: flex; align-items: center; min-height: 41px; padding: 0 10px;
  border: 1px solid var(--line); border-radius: var(--radius); }
.dock .heading { padding-right: var(--tool-dock-actions-space, 82px); }
@container ssh-loading (max-width: 880px) {
  .navigation { display: block; }
  .split { grid-template-columns: minmax(0, 1fr); }
  .list { border-right: 0; }
  .list-header, .body { display: none; }
}
@container ssh-loading (max-width: 560px) {
  .summary { display: none; }
}
</style>
