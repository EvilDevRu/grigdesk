<template>
  <UiLoadingState :label="label" :failed="failed">
    <div class="grid">
      <div class="connection" data-loading-region="connection"><UiSkeletonLayout layout="form" /></div>
      <div class="connection"><UiSkeletonLayout layout="form" /></div>
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
.grid { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(340px, 1fr);
  gap: 14px; max-width: 1100px; }
.connection { padding: 18px; border: 1px solid var(--line); border-radius: var(--radius); min-width: 0; }
@media (max-width: 760px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
