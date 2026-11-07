<template>
  <UiLoadingState :label="label" :description="description" :failed="failed">
    <div class="metadata" data-loading-region="metadata">
      <UiSkeleton width="16%" />
      <UiSkeleton width="45%" />
      <UiSkeleton width="12%" />
    </div>
    <div class="text"><UiSkeletonLayout layout="text" :rows="8" /></div>
  </UiLoadingState>
</template>

<script setup lang="ts">
import { UiLoadingState, UiSkeleton, UiSkeletonLayout } from '../../ui';

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
.metadata { display: flex; align-items: center; gap: 8px; min-height: 36px;
  padding: 7px max(24px, calc((100% - 872px) / 2)); border-bottom: 1px solid var(--line); }
.text { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 30px 24px 72px; }
@media (max-width: 759px) {
  .metadata { padding: 7px 14px; }
  .text { width: 100%; padding: 22px 14px 56px; }
}
</style>
