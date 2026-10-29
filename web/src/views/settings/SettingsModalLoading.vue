<template>
  <UiDialog open size="workspace" :label="t('settings.settings')" :body-inset="false" :dismissible="false">
    <template #header><UiSkeleton width="180px" height="24px" /></template>
    <div class="modal-loading">
    <UiLoadingState>
      <div class="workspace">
        <div class="sidebar"><UiSkeletonLayout :rows="8" /></div>
        <div class="content"><UiSkeletonLayout layout="form" :rows="6" /></div>
      </div>
    </UiLoadingState>
    </div>
    <template #footer><UiSkeleton width="240px" height="32px" /></template>
  </UiDialog>
</template>

<script setup lang="ts">
import { UiDialog, UiLoadingState, UiSkeleton, UiSkeletonLayout, t } from '../../ui';

defineOptions({ inheritAttrs: false });
</script>

<style scoped>
.modal-loading { flex: 1; min-height: 0; }
.workspace { display: grid; grid-template-columns: 244px minmax(0, 1fr); min-height: 480px; }
.sidebar { padding: 20px 16px; border-right: 1px solid var(--line); }
.content { min-width: 0; padding: 24px 28px; }
@media (max-width: 900px) {
  .workspace { grid-template-columns: 216px minmax(0, 1fr); }
}
@media (max-width: 600px) {
  .workspace { grid-template-columns: minmax(0, 1fr); }
  .sidebar { display: none; }
  .content { padding: 16px; }
}
</style>
