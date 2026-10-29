<template>
  <UiLoadingState :label="label" :failed="failed">
    <div class="header" data-loading-region="header">
      <UiSkeleton width="100px" height="24px" />
      <div class="tabs" data-loading-region="tabs">
        <UiSkeleton width="48%" height="30px" />
        <UiSkeleton width="48%" height="30px" />
      </div>
    </div>
    <div v-for="index in 3" :key="index" class="card" data-loading-region="card">
      <UiSkeleton width="40%" />
      <UiSkeleton width="64%" height="18px" />
      <UiSkeletonLayout layout="text" :header="false" :rows="2" />
    </div>
  </UiLoadingState>
</template>

<script setup lang="ts">
import { UiLoadingState, UiSkeleton, UiSkeletonLayout } from '../ui';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  label?: string;
  description?: string;
  failed?: boolean;
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
});
</script>

<style scoped>
.header { display: flex; align-items: center; gap: 14px; max-width: 1160px;
  height: 42px; margin: 6px 0 10px; }
.tabs { display: flex; flex: 1; align-items: center; gap: 2px; padding: 3px; height: 42px; }
.card { max-width: 1160px; display: grid; gap: 16px; padding: 16px;
  border: 1px solid var(--line); border-radius: var(--radius); margin-bottom: 12px; }
@media (max-width: 680px) {
  .header { align-items: stretch; flex-direction: column; height: 81px; }
  .tabs { flex: none; width: 100%; }
}
</style>
