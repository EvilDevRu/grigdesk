<template>
  <UiLoadingState :label="label" :description="description" :failed="failed">
    <div :class="['task-loading', area]">
      <UiSkeleton v-if="area === 'options'" width="50%" />
      <template v-else-if="area === 'window'">
        <UiSkeleton height="48px" />
        <UiSkeletonLayout layout="text" />
        <UiSkeletonLayout layout="list" />
      </template>
      <UiSkeletonLayout v-else :layout="area === 'comments' ? 'list' : 'text'" :header="false" />
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
  area?: 'description' | 'options' | 'comments' | 'window';
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
  area: 'description',
});
</script>

<style scoped>
.task-loading { min-width: 0; }
.options { display: flex; align-items: center; height: 36px; padding: 8px 12px; }
.window { display: grid; grid-template-columns: 2fr 1fr; gap: 24px; padding: 24px; }
.window > :first-child { grid-column: 1 / -1; }
@media (max-width: 600px) {
  .window { grid-template-columns: minmax(0, 1fr); }
}
</style>
