<template>
  <UiLoadingState :label="label" :failed="failed">
    <div class="grid">
    <div class="connection" data-loading-region="connection">
      <UiSkeletonLayout :layout="connected ? 'list' : 'form'" :rows="3" />
    </div>
    <div class="connection"><UiSkeletonLayout /></div>
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
  connected?: boolean;
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
  connected: false,
});
</script>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.connection { padding: 16px; border: 1px solid var(--line); border-radius: var(--radius); }
@media (max-width: 900px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
